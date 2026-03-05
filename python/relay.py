import dataclasses
from typing import Any, List

import library_gen as lg

fw = lg.DeciderFramework[Any](
    "relay.js",
    "InMemStorage",
    lambda events: {"events": events, "checkpoint": None},
    "deciderProjector",
)

event = {
    "type": "add-edition",
    "isbn": "my-isbn",
    "title": "cheech-and-chong-learn-event-sourcing",
    "timestamp": "2025-01-24T15:54:32Z",
}
assert not (errors := lg.checkLibraryEvents(event)), "errors:\n  - " + "\n  - ".join(errors)

@dataclasses.dataclass
class Book:
    title: str
    copies: int

@fw.new_query
async def book_list(qx: lg.DeciderStoreQueryContext, *_: Any) -> List[Book]:
    return [
        Book(
            title=(edition := await qx.edition(isbn)).title,
            copies=len(edition.books),
        )
        for isbn in await qx.editions()
    ]

book_list.subscribe(lambda bl: print("book list is:", bl))

fw.recv_events([event])
fw.run()

fw.recv_events([{
    "type": "add-edition",
    "isbn": "my-isbn-2",
    "title": "everyone-else-learns-event-sourcing",
    "timestamp": "2025-01-24T15:54:32Z",
}])
fw.run()
