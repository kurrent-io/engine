import asyncio
import contextlib
import collections.abc
import dataclasses
import json
import logging
import os
from typing import (
    Any,
    AsyncGenerator,
    Awaitable,
    Callable,
    Coroutine,
    Dict,
    Generator,
    Iterable,
    List,
    Never,
    Set,
    Tuple,
)

from aiohttp import web
import kurrentdbclient as kdbc

import model


logging.basicConfig(level=logging.INFO)
log = logging.getLogger("relay")

# a sentinel to be used in place of patron_id for administrators
class Admin(object):
    pass

ADMIN = Admin()

PatronID = str | Admin

# note: RelayCommands is an alias in model/library.py, and model.AdminCommands is equivalent
RelayCommands = model.AdminCommands

EventQ = asyncio.Queue[kdbc.RecordedEvent]


async def waitgroup(*coros: Coroutine) -> None:
    """Run multiple coroutines to completion, or cancel the rest after one crashes."""
    try:
        async with asyncio.TaskGroup() as tg:
            for coro in coros:
                tg.create_task(coro)
    except BaseExceptionGroup as e:
        # preserve first exception... why would I ever want anything else
        raise e.exceptions[0]


class Sync:
    """
    A small utility for tracking round trips through the database.

    With each batch of writes we submit, we record the resulting stream position, then wait
    for the $all stream subscription to reach that position.
    """
    def __init__(self) -> None:
        self.cond = asyncio.Condition()
        self.value = 0

    async def wait_for(self, position: int) -> None:
        async with self.cond:
            while self.value < position:
                await self.cond.wait()

    def update(self, value: int) -> None:
        self.value = value
        self.cond.notify_all()


def assert_never(arg: Never) -> Never:
    raise AssertionError("Expected code to be unreachable")


def stream_for(event: RelayCommands) -> str:
    match event.type:
        case "add-edition":            return "books"
        case "update-edition-title":   return "books"
        case "add-book":               return "books"
        case "update-book-restricted": return "books"
        case "remove-book":            return "books"

        case "add-patron":    return f"patron.{event.id}"
        case "rename-patron": return f"patron.{event.id}"
        case "assign-patron": return f"patron.{event.id}"

        case "try-hold":     return "status"
        case "cancel-hold":  return "status"
        case "try-checkout": return "status"
        case "end-checkout": return "status"
        case _: assert_never(event)


class Appender:
    """Appender appends events to the database."""
    def __init__(self, sync: Sync, client: kdbc.AsyncKurrentDBClient) -> None:
        self.sync = sync
        self.client = client

    async def append(self, new_uuids: List[str], batch: List[RelayCommands]) -> None:
        # the plural of NewEvents is "new_eventses", which you have to say with a Gollum voice.
        new_eventses = []

        # First add any newly-created uuids.
        #
        # We use kurrent's optimistic concurrency locks to ensure that each client-generated uuid is
        # unique.  This comes at the cost of one tiny stream per uuid in the system, which is not
        # unbearable.  But we could reduce to something like 65K streams of one event each, by:
        #
        #   - tracking all known uuids in the read model
        #   - grouping uuids into buckets by, say, the first 4 hex chars
        #   - writing an event to the bucket of each new uuid with each batch of submissions.  If
        #     the write fails, you need to wait for the new revision for that bucket stream to
        #     arrive, then retry.
        #
        # Without some sort of real-life limitation, that complexity is not justified.
        for u in new_uuids:
            new_eventses.append(
                kdbc.NewEvents(
                    stream_name=f"uuid.{u}",
                    events=[kdbc.NewEvent(type='UuidExists', data=b'{}')],
                    current_version=kdbc.StreamState.NO_STREAM,
                ),
            )

        # then add the events
        last_stream = None
        events: List[kdbc.NewEvent] = []
        for event in batch:
            stream = stream_for(event)
            if not last_stream != stream:
                # start a new NewEvents object, with a new events list that we'll grow
                last_stream = stream
                events = []
                new_eventses.append(
                    kdbc.NewEvents(
                        stream_name=stream,
                        events=events,
                        current_version=kdbc.StreamState.ANY,
                    )
                )
            events.append(
                kdbc.NewEvent(type="LibraryEvents", data=json.dumps(event).encode('utf8')),
            )

        position = await self.client.multi_append_to_stream(new_eventses)

        # wait for the round trip to complete, so the Reader's next call to fw.simulate can rely
        # on these events we've just written.
        await self.sync.wait_for(position)


class Subscriber:
    """Subscriber subscribes to the database."""
    def __init__(
        self, sync: Sync, fw: model.RelayFramework, client: kdbc.AsyncKurrentDBClient,
    ) -> None:
        self.sync = sync
        self.fw = fw
        self.client = client
        self.watches: Dict[PatronID, List[Callable[[bytes, int], None]]] = {}
        self.q: asyncio.Queue[kdbc.RecordedEvent] = asyncio.Queue(100)

    async def start(self) -> None:
        # catch up to current state once before turning on the webserver
        since = self.fw.reconnect()
        async with await self.client.read_all(
            commit_position=since,
            resolve_links=True,
            filter_by_prefix=True,
            filter_include=(
                "books",
                "patron.",
                "status",
                "vstatus",
                "sync",
            ),
        ) as stream:
            batch = []
            async for event in stream:
                batch.append(event)
                if len(batch) == 1000:
                    self.update_read_model(batch)
                    batch = []
        if batch:
            self.update_read_model(batch)

    async def run(self) -> None:
        await waitgroup(self.collect(), self.process())

    async def collect(self) -> None:
        """
        XXX: this may not be doing what I want it to; what I want is to only apply backpressure to
        the network when there are 1000 unprocessed events in the queue... but what I think is
        happening is that the collector is always stopped while processing occurs.  This is unlike
        the go version, where different goroutines can actually run on different hardware threads.

        This needs testing.
        """
        since = self.fw.reconnect()
        async with await self.client.subscribe_to_all(
            commit_position=since,
            resolve_links=True,
            filter_by_prefix=True,
            filter_include=(
                "books",
                "patron.",
                "status",
                "vstatus",
                "sync",
            ),
        ) as stream:
            async for event in stream:
                await self.q.put(event)

    async def process(self) -> None:
        # get one or more events from collector
        batch = []
        batch.append(await self.q.get())
        while not self.q.empty():
            batch.append(self.q.get_nowait())

        self.update_read_model(batch)
        self.dispatch(batch)

    def update_read_model(self, batch: List[kdbc.RecordedEvent]) -> None:
        # first read all the json
        events = []
        for event in batch:
            events.append(json.loads(event.data))

        position = batch[-1].stream_position

        # apply updates to the read model
        self.fw.recv_events(events, position)

        # notify anybody who was waiting for a round-trip
        self.sync.update(position)

    def dispatch(self, batch: List[kdbc.RecordedEvent]) -> None:
        # also dispatch the events to the various watches
        for event in batch:
            match event.stream_name.split(".", maxsplit=1):
                # events not relayed to end users:
                case ("status", _):
                    pass

                # events with global distribution
                case ("books", _):
                    for put in (put for w in self.watches.values() for put in w):
                        put(event.data, event.stream_position)

                # events with limited distribution
                case ("patron", patron_id):
                    for put in self.watches.get(patron_id, []):
                        put(event.data, event.stream_position)
                    # always include admins
                    for put in self.watches.get(ADMIN, []):
                        put(event.data, event.stream_position)

                # events needing sanitization
                case ("vstatus", _):
                    # we'll need to examine the contents of this message type
                    j = json.loads(event.data)
                    typ = j["type"]

                    # calculate sanitized versions for specific events
                    sanitized = None
                    if typ in ("new-vhold", "new-vcheckout"):
                        temp = dict(j)
                        del temp["patron_id"]
                        sanitized = json.dumps(temp).encode('utf8')

                    # actually distribute the events
                    for put, w_patron_id in (
                        (put, w_patron_id) for w_patron_id, w in self.watches.items() for put in w
                    ):
                        if typ == "vhold-rejected" and w_patron_id != j["patron_id"]:
                            # this event is only for the patron whose hold was rejected
                            continue
                        elif sanitized and patron_id not in (ADMIN, j["patron_id"]):
                            # emit sanitized message
                            put(sanitized, event.stream_position)
                        else:
                            # emit full message
                            put(event.data, event.stream_position)

    async def catchup(
        self, patron_id: PatronID, since: int,
    ) -> AsyncGenerator[Tuple[bytes, int]]:
        patron_stream_prefix = "patron." + ("" if patron_id == ADMIN else str(patron_id))
        async with await self.client.read_all(
            commit_position=since,
            resolve_links=True,
            filter_by_prefix=True,
            filter_include=(
                "books",
                patron_stream_prefix,
                "vstatus",
            ),
        ) as stream:
            async for event in stream:
                if patron_id == ADMIN or event.stream_name != "vstatus":
                    yield event.data, event.stream_position
                    continue
                # sanitize the vstatus stream
                j = json.loads(event.data)
                typ = j.type
                if typ == "vhold-rejected" and patron_id != j.patron_id:
                    # skip
                    continue
                if typ in ("new-vhold", "new-vcheckout"):
                    # sanitize
                    del j["patron_id"]
                yield json.dumps(j).encode('utf8'), event.stream_position


    async def stream(self, patron_id: PatronID, since: int, w: Writer) -> None:
        """Start with a catchup subscription, then move to a live subscription."""

        # first do a cold catchup, which may take a while (we don't want to collect live events yet)
        async for event, position in self.catchup(patron_id, since):
            await w.put_start(event)
            since = position

        # now subscribe to live events
        self.watches.setdefault(patron_id, []).append(w.put_live)
        try:
            # do a hot catchup to make sure we don't miss any events
            async for event, position in self.catchup(patron_id, since):
                await w.put_start(event)
                since = position

            # transition to the liveq, discarding duplicate events
            await w.go_live(since)

            # now just wait to be canceled
            await asyncio.Future()

        finally:
            filtered = [p for p in self.watches[patron_id] if p is not w.put_live]
            if filtered:
                self.watches[patron_id] = filtered
            else:
                del self.watches[patron_id]


class Writer:
    """
    Writer is responsibe for sending events on the websocket.

    It also provides tools for the Subscriber to transition from catchup subscriptions (based on
    reading from the database) to live subscriptions (based on in-memory dispatch of a shared $all
    stream subscription).
    """
    def __init__(self, patron_id: PatronID, ws: web.WebSocketResponse) -> None:
        self.patron_id = patron_id
        self.ws = ws
        self.startq: asyncio.Queue[None | bytes] = asyncio.Queue(10)
        self.liveq: asyncio.Queue[Tuple[bytes, int]] = asyncio.Queue(100)
        # call _run() now so we have a handle for canceling it
        self.coro = self._run()

    async def run(self) -> None:
        await self.coro

    async def _run(self) -> None:
        # drain the startq until we see the None sentinel, ending that stream
        while True:
            msg = await self.startq.get()
            if msg is None: break
            await self.ws.send_bytes(msg)

        # then drain the liveq forever
        while True:
            msg, _ = await self.liveq.get()
            await self.ws.send_bytes(msg)

    async def put_start(self, obj: Any) -> None:
        await self.startq.put(obj)

    def put_live(self, msg: bytes, position: int) -> None:
        try:
            self.liveq.put_nowait((msg, position))
        except asyncio.QueueFull:
            self.fell_behind()

    def fell_behind(self) -> None:
        try:
            self.coro.throw(UserError("fell behind"))
        except StopIteration:
            pass

    async def go_live(self, since: int) -> None:
        """
        Transition from reading startq to reading liveq, making sure to discard any duplicate
        events on liveq that we may have noticed during the hot catchup step.
        """
        # discard any duplicate events from liveq
        while True:
            try:
                # pop duplicates from the queue
                event, position = self.liveq.get_nowait()
            except asyncio.QueueEmpty:
                # liveq is empty
                break
            if position <= since: continue
            # oops this isn't a duplicate; make it the last event on the startq
            await self.startq.put(event)
            break
        # push a sentinel to the startq, so self._run() will switch
        await self.startq.put(None)


class UserError(Exception):
    pass


class Reader:
    """
    Reader reads incoming commands from the
    """
    def __init__(
        self,
        fw: model.RelayFramework,
        appender: Appender,
        patron_id: PatronID,
        ws: web.WebSocketResponse,
    ) -> None:
        self.fw = fw
        self.appender = appender
        self.patron_id = patron_id
        self.ws = ws
        # size of the queue is the maximum batch size we can process
        self.q: asyncio.Queue[Any] = asyncio.Queue(100)

        if patron_id == ADMIN:
            self.validate = fw.module["validateAdminCommands"]
        else:
            self.validate = fw.module["validatePatronCommands"]

    async def run(self) -> None:
        await waitgroup(self.collect(), self.process())

    async def collect(self) -> None:
        """Collect websocket messages as they arrive, to be processed in batches."""
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
            obj = msg.json()
            errors = model.checkAdminCommands(obj)
            if errors:
                raise UserError(errors)

            await self.q.put(obj)

        # we are out of messages; cancel the remaining concurrent tasks by raising an exception
        raise ConnectionError("Reader() is out of messages")

    async def process(self) -> None:
        """Process events in batches, provided by collect()."""
        while True:
            # get one or more events from collector
            batch = []
            batch.append(await self.q.get())
            while not self.q.empty():
                batch.append(self.q.get_nowait())

            # make sure each event is semantically valid
            new_uuids, errors = self.fw.simulate(lambda rx: self.validate(rx, batch))
            if errors:
                raise UserError(errors)

            await self.appender.append(new_uuids, batch)


WsHandler = Callable[[web.Request], Coroutine[Any, Any, web.WebSocketResponse]]


def cancelable_request(fn: WsHandler) -> WsHandler:
    """Cancel any connected sockets if the app-wide cancel event is set."""
    async def _fn(request: web.Request) -> web.WebSocketResponse:
        cancel_event = request.app["cancel_event"]
        cancel = asyncio.create_task(cancel_event.wait())
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
async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    fw = request.app["framework"]
    client = request.app["client"]
    subscriber = request.app["subscriber"]
    appender = request.app["appender"]

    # TODO: have some real authentication
    patron_id: PatronID = request.headers["patron-id"] or ADMIN
    since = int(request.headers["since"])

    # enable heartbeat every 55 seconds, to keep nginx or any NAT layers from timing out in 60
    ws = web.WebSocketResponse(autoping=True, heartbeat=55)
    try:
        await ws.prepare(request)

        w = Writer(patron_id, ws)
        r = Reader(fw, appender, patron_id, ws)

        await waitgroup(w.run(), r.run(), subscriber.stream(patron_id, since, w))

        return ws

    except ConnectionError as e:
        log.debug(f"broken connection: {e}")
        # Return the ws response or otherwise aiohttp gets confused.  If we raise an exception here
        # aiohttp insists on logging it, so this seems to be the quiet "go away" strategy.
        return ws
    except Exception as e:
        log.error(e)
        raise
    finally:
        await ws.close()


@contextlib.asynccontextmanager
async def setupKurrent(
    fw: model.RelayFramework, connstr: str,
) -> AsyncGenerator[kdbc.AsyncKurrentDBClient, Subscriber]:
    async with kdbc.AsyncKurrentDBClient(connstr) as client:
        yield client


@contextlib.asynccontextmanager
async def setupWebserver(listen_spec: str, app_data: Dict[str, Any]) -> AsyncGenerator[None]:
    App = web.Application()
    for k, v in app_data.items():
        App[k] = v

    # close websockets when we get a close signal (see @cancelable_request)
    cancel_event = asyncio.Event()
    App["cancel_event"] = cancel_event

    async def on_shutdown(app: web.Application) -> None:
        cancel_event.set()

    App.on_shutdown.append(on_shutdown)

    App.add_routes(route)
    runner = web.AppRunner(App)
    await runner.setup()

    host, port = listen_spec.split(":")
    site = web.TCPSite(runner, host, int(port or "80"))
    listening = f"http://{host or 'localhost'}:{port or '80'}"

    await site.start()

    try:
        yield
    finally:
        await site.stop()
        await runner.cleanup()


async def amain(connstr: str) -> None:
    # set up the sync engine framework
    fw = model.RelayFramework[int](
        os.path.join(os.path.dirname(__file__), "relay.js"),
        "InMemStorage",
        "relayMigrate",
        "relayReducer",
    )

    # set up our kurrentdb client
    async with setupKurrent(fw, connstr) as client:

        # create the appender and subscriber
        sync = Sync()
        appender = Appender(sync, client)
        subscriber = Subscriber(sync, fw, client)

        # let the subscriber catch up to current state before accepting websocket connections
        await subscriber.start()

        # set up the webserver
        async with setupWebserver("localhost:3003", {
            "client": client,
            "appender": Appender,
            "subscriber": Subscriber,
        }):

            print("ready")

            # run until we are canceled
            await subscriber.run()


if __name__ == "__main__":
    connstr = "kurrentdb://admin:changeit@localhost:2113?tls=false"
    try:
        asyncio.run(amain(connstr))
    except KeyboardInterrupt:
        pass
