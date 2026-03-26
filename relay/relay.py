import asyncio
import dataclasses
import os
from typing import Any, List

import model as model


async def waitgroup(*coros):
    """
    Return a coroutine that propagates the first non-CancelledError from coros,
    or else waits for all to finish.

    If a failure is to be raised, either due to one of coros crashing or due
    to the waitgroup coroutine itself being canceled, any remaining coros are
    canceled and awaited first, so none of coros will ever outlive the
    waitgroup coroutine.
    """

    tasks = [
        asyncio.create_task(c) if asyncio.iscoroutine(c) else c for c in coros
    ]
    exc = None
    while tasks and exc is None:
        try:
            done, pending = await asyncio.wait(
                tasks, return_when=asyncio.FIRST_EXCEPTION
            )
        except asyncio.CancelledError as e:
            # the waitgroup itself was canceled
            exc = e
            break

        # grab the first exception
        # (but visit every task to avoid "exception was never retrieved" errors)
        for task in done:
            try:
                if task.exception() is None:
                    continue
            except asyncio.CancelledError:
                # ignore Cancelled errors.
                continue
            if exc is None:
                # found the first exception
                exc = task.exception()

        tasks = pending

    if tasks:
        # absolutely refuse to not wait on all our children
        for task in tasks:
            task.cancel()
        for task in tasks:
            try:
                # wait on this task
                await task
                # discard exception
                _ = task.exception()
            except asyncio.CancelledError:
                pass

    if exc:
        raise exc



fw = model.DeciderFramework[Any](
    os.path.join(os.path.dirname(__file__), "relay.js"),
    "InMemStorage",
    "deciderMigrate",
    "deciderReducer",
)


class Writer:
    def __init__(self, ws):
        self.ws = ws
        self.q = asyncio.Queue(100)

    async def put(self, obj):
        await self.q.put(obj)

    async def run(self):
        try:
            while True:
                obj = await self.q.get()
                msgstr = app.tojson(obj)
                log.debug(f"send: {msgstr}")
                await self.ws.send_str(msgstr)
        finally:
            await self.ws.close()


class Streamer:
    def __init__(self, relay, patron_id, since, w):
        self.relay = relay
        self.patron_id = patron_id
        self.w = w

    async def run(self):
        # first do a cold catchup, which may take a while (we don't want to collect live events yet)
        with relay.catchup(patron_id, since) as events:
            for event in events:
                await self.send(event)
                since = event.position

        # now collect live events, and do a hot catchup, to make sure we didn't miss any events
        q = asyncio.Queue()
        self.relay.watch(patron_id, q)
        try:
            with relay.catchup(patron_id, since) as events:
                for event in events:
                    await self.send(event)
                    since = event.position

            # now stream live events
            while True:
                event = await q.get()
                if event.position <= since: continue
                await self.send(event)

        finally:
            # disconnect from live updates
            self.relay.unwatch(patron_id)

    async def send(self, event):
        # scrub vstatus events
        typ = event["type"]
        if typ in ("new-vhold", "new-vcheckout"):
            # scrub patron_id which is not this client's
            if event["patron_id"] != self.patron_id:
                event = dict(event)
                del event["patron_id"]
        elif typ == "vhold-rejected":
            # a client can only see their own rejections
            if event["patron_id"] != self.patron_id:
                return
        await self.w.put(event)


class UserError(Exception):
    pass


class Reader:
    def __init__(self, fw, relay, ws, patron_id, w):
        self.fw = fw
        self.relay = relay
        self.ws = ws
        self.patron_id = patron_id
        # size of the queue is the maximum batch size we can process
        self.q = asyncio.Queue(100)

        self.validate = fw.module["validate"]

    async def collect(self):
        """Collect events as they arrive, to be processed in batches."""
        async for msg in self.ws:
            log.debug(f"recv: {msg}")
            if msg.type == web.WSMsgType.ERROR:
                # websocket failed
                if isinstance(msg.data, TimeoutError):
                    # ConnectionErrors are logged at debug level because they're rarely useful
                    raise ConnectionError("timeout")
                # unknown errors are logged at error level, so we can learn them and decide if they
                # are useful or not
                if isinstance(msg.data, BaseException):
                    raise msg.data
                raise ValueError(
                    f"websocket failed with type=ERROR but no exception: data={msg.data}"
                )

            # make sure each event is structurally valid
            event, errors = model.checkLibraryEvents(msg.json())
            if errors:
                raise UserError(errors)

            await self.q.put(event)

        # we are out of messages; cancel the remaining concurrent tasks by raising an exception
        raise ConnectionError("Reader() is out of messages")

    async def process(self):
        while True:
            # get one or more events from collector
            batch = []
            batch.append(await self.q.get())
            while not self.q.empty():
                batch.append(self.q.get_nowait())

            with contextlib.ExitStack() as es:
                process_one(es, batch)

    async def process_one(self, es, batch):
        # make sure each event is semantically valid
        new_uuids, errors = self.fw.simulate(lambda rx: self.validate(rx, events))
        if errors:
            raise UserError(errors)

        # add events in-order
        new_events = []
        for event in events:
            stream = stream_for(event)
            if not new_events or new_events[-1].stream != stream:
                new_events.append(NewEvents(stream, expected_state=ANY))
                new_events[-1].data.append(data_for(event))

        prefix_revisions = {}
        ready = asyncio.Event()
        if new_uuids:
            # query for prefixes
            for prefix in sorted(new_uuids):

                @self.fw.new_query
                async def query(qx, *_):
                    prefix_revisions[prefix] = await qx.prefix_revision(prefix)
                    ready.set()

                defer(es, lambda q: q.close(), query)

            # XXX: also need to query for existence of individual new_uuids, so we can detect
            #      conflicts

            # run initial query for current prefix revisions
            self.fw.run()
            assert ready.is_set()
            ready.clear()

            # add new_uuids at the end
            for prefix, uuids in new_uuids.items():
                rev = prefix_revisions[prefix]
                expected_state = rev if rev is not None else DOES_NOT_EXIST
                new_events.append(NewEvents(f"prefix.{prefix}", expected_state=expected_state))
                for u in uuids:
                    new_events[-1].data.append(data_for(u))

        # submit our batch of events
        while True:
            try:
                result = await client.multi_append_to_stream(events=[NewEvents(), NewEvents()])
                break
            except StreamRevisionError:
                pass
            # wait to receive an update to our relevant prefix revisions
            await ready.wait()
            ready.clear()
            # update the request with new revision data
            for prefix, ne in zip(sorted(new_uuids), new_events[-len(new_uuids):]):
                rev = prefix_revisions[prefix]
                expected_state = rev if rev is not None else DOES_NOT_EXIST
            # resubmit
            continue

        # now wait for that data to appear in our round trip
        if new_uuids:
            # Since the submission succeeded, we are guaranteed to be the next update to our
            # prefix revision data.  Since the prefix revisions come after all regular data,
            # any update to any of our prefix revision queries means all regular data has
            # already arrived.
            await ready.wait()
            return

        # wait for the stream revision of our final piece of data to reflect the appended result
        stream = new_events[-1 - len(new_uuids)].stream
        target = [r.revision for r in result if r.stream == stream][0]
        round_trip = asyncio.Event()

        @self.fw.new_query
        async def query(qx, *_):
            if await qx.revision(stream) >= target:
                round_trip.set()

        defer(es, lambda q: q.close(), query)
        await round_trip.wait()

        # TODO: that was hard!  Maybe we should just support one-length streams on the db and call
        #       it a day.  That would be super easy!


    async def submit(self, event):
        # first validate against read model
        validator = fw.module[""]

        # validate
        fw.simulate(fw.module["validate"])

        # validate against read model
        new_uuids = []

        # TODO: validate incoming user data against read model
        # - make sure all modification operations modify a real, existing object
        # - collect all new uuids as well

        # user event is essentially valid, but we do need to ensure global uniqueness of
        # newly-created uuids.  This is a defense against malicious clients who would seek to
        # corrupt the database; well-behaved clients should never have this problem

        # TODO: actually write events to the database

        # send new uuids as multi-stream appends with a new uuid event
        # if we fail, query for:
        # - that uuid's existence
        # - the prefix of that uuid's value

        # check for existence of uuid
        # - query for it in lmdb
        # - if exists, reject event now
        # - if at any point it starts to exist, break connection; this is an attack
        # - query for prefix stream revision
        # - wait for both results
        # - while query not exists:
        #    - submit multi-stream-append
        #    - if it fails, wait for either query to be updated

        # storage:
        # - uuid.{theuuid}: Literal(True),
        # - prefix.{prefix}: String,

        # kurrentdb streams:
        # - prefix.{prefix}: [uuids in this msa]

        """
        THOUGHTS:
          - we could reuse the forecasters to build a per-client overlay, so that we could continue
            to validate incoming events against the global state plus expected per-client state
          - we would need to somehow efficiently check all incoming events against each per-client
            state to know when it was safe to discard an event
          - this is too hard.

          - we could batch incoming events from the client, and process them in batches
          - each batch, we could wait for the round-trip before proceeding
          - the round trip could include waiting for the events to appear in the read model
          - there is no overlay, no forecasting, and no invalidation needed.
        """
        # THOUGHTS:
        # -


# cancel_event is an application-wide signal to close all open websockets
cancel_event = asyncio.Event()


async def close_all_websockets(app):
    cancel_event.set()


def cancelable_request(fn):
    """Cancel any connected sockets if the app-wide cancel event is set."""
    async def _fn(request):
        cancel_event = request.app["cancel_event"]

        cancel = asyncio.create_task(request.app["cancel_event"].wait())
        handler = asyncio.create_task(fn(request))

        _ = await asyncio.wait([cancel, handler], return_when=asyncio.FIRST_COMPLETED)
        if cancel.done():
            handler.cancel()
            return await handler
        else:
            cancel.cancel()
            return handler.result()
    return _fn


route = web.RouteTableDef()

@route.get("/ws")
@cancelable_request
async def ws_handler(request):
    fw = request.app["framework"]
    relay = request.app["relay"]

    # TODO: get patron id from header
    patron_id = request.headers["patron-id"]

    # stream shall how we get all events for this patron
    stream = None
    ws = web.WebSocketResponse(autoping=True, heartbeat=55)
    try:
        # enable heartbeat every 55 seconds, to keep nginx or any NAT layers from timing out in 60
        await ws.prepare(request)

        # Writer to serialize writing messages to the websocket
        w = Writer(ws)
        # Streamer to pull stream data from database
        s = Streamer(relay, patron_id, since, w)
        # Reader to read and process messages from the client
        r = Reader(fw, relay, ws, patron_id, w)

        await waitgroup(w.run(), s.run(), r.collect(), r.submit())

        return ws
    except ConnectionError as e:
        log.debug(f"broken connection: {e}")
        # Return the ws response or otherwise aiohttp gets confused.  If we raise an exception here
        # aiohttp insists on logging it, so this seems to be the quiet "go away" strategy.
        return ws
    except Exception as e:
        log.error(e)
        raise


async def setupWebserver(listen_spec):

    App = web.Application()
    App.on_shutdown.append(close_all_websockets)

    App.add_routes(route)
    runner = web.AppRunner(App)
    await runner.setup()

    host, port = listen_spec.split(":")
    site = web.TCPSite(runner, host, int(port or "80"))
    listening = f"http://{host or 'localhost'}:{port or '80'}"

    await site.start()

    async def run():
        try:
            await waitgroup(l.run(), raft.run())
        finally:
            await site.stop()
            await runner.cleanup()
    return run

async def amain():
    fw = setupFramework()
    client, runKurrent = setupKurrent()
    runServer = await setupWebserver("localhost:3003")

    print("ready")

    await waitgroup(runServer(), runKurrent())
    awaiwaitgroup





if __name__ == "__main__":
    asyncio.run(amain())


# event = {
#     "type": "add-edition",
#     "isbn": "my-isbn",
#     "title": "cheech-and-chong-learn-event-sourcing",
#     "timestamp": "2025-01-24T15:54:32Z",
# }
# assert not (errors := model.checkLibraryEvents(event)), "errors:\n  - " + "\n  - ".join(errors)
#
# @dataclasses.dataclass
# class Book:
#     title: str
#     copies: int
#
# @fw.new_query
# async def book_list(qx: model.DeciderQueryContext, *_: Any) -> List[Book]:
#     return [
#         Book(
#             title=(edition := await qx.edition(isbn)).title,
#             copies=len(edition.books),
#         )
#         for isbn in await qx.editions()
#     ]
#
# @book_list.subscribe
# def book_list_sub(bl: List[Book]) -> None:
#     print("book list is:")
#     print("  - " + "\n  - ".join(f"{b.title} (x{b.copies})" for b in bl))
#
# fw.recv_events([event], None)
# fw.run()
#
# fw.recv_events([{
#     "type": "add-edition",
#     "isbn": "my-isbn-2",
#     "title": "everyone-else-learns-event-sourcing",
#     "timestamp": "2025-01-24T15:54:32Z",
# }], None)
# fw.run()
