"""
from: https://github.com/ddd-by-examples/library

A public library allows patrons to place books on hold at its various library
branches. Available books can be placed on hold only by one patron at any given
point in time. Books are either circulating or restricted, and can have
retrieval or usage fees. A restricted book can only be held by a researcher
patron. A regular patron is limited to five holds at any given moment, while a
researcher patron is allowed an unlimited number of holds. An open-ended book
hold is active until the patron checks out the book, at which time it is
completed. A closed-ended book hold that is not completed within a fixed number
of days after it was requested will expire. This check is done at the beginning
of a day by taking a look at daily sheet with expiring holds. Only a researcher
patron can request an open-ended hold duration. Any patron with more than two
overdue checkouts at a library branch will get a rejection if trying a hold at
that same library branch. A book can be checked out for up to 60 days. Check
for overdue checkouts is done by taking a look at daily sheet with overdue
checkouts. Patron interacts with his/her current holds, checkouts, etc. by
taking a look at patron profile. Patron profile looks like a daily sheet, but
the information there is limited to one patron and is not necessarily daily.
Currently a patron can see current holds (not canceled nor expired) and current
checkouts (including overdue). Also, he/she is able to hold a book and cancel a
hold.

How actually a patron knows which books are there to lend? Library has its
catalogue of books where books are added together with their specific
instances. A specific book instance of a book can be added only if there is
book with matching ISBN already in the catalogue. Book must have non-empty
title and price. At the time of adding an instance we decide whether it will be
Circulating or Restricted. This enables us to have book with same ISBN as
circulated and restricted at the same time (for instance, there is a book
signed by the author that we want to keep as Restricted)
"""

from protos import (
    Alias,
    Array,
    Bool,
    Concrete,
    Date,
    Int,
    Literal,
    Maybe,
    Null,
    Object,
    Store,
    String,
    Struct,
    Union,
    Framework,
)

def Enum(*strings):
    return Union(*(Literal(s) for s in strings))

###################
## Storage Layer ##
###################

Uuid = Alias(String)
Isbn = Alias(String)
Setx = Object(Literal(True))

Edition = Struct(
    isbn=Isbn,
    title=String,
    books=Setx,
    # edition-level holds
    holds=Setx,
)

Book = Struct(
    id=Uuid,
    isbn=Isbn,
    restricted=Bool,
    timestamp=Date,
    # book-level holds and checkouts
    status=Maybe(Struct(hold=Uuid) | Struct(checkout=Uuid)),
)

# servers and clients keep the same data
BookStore = Store({
    "edition.{edition_isbn}": Edition,
    "editions": Setx,
    "book.{book_uuid}": Book,
})

Patron = Struct(
    id=Uuid,
    name=String,
    researcher=Bool,
    checkouts=Setx,
    holds=Setx,
)

# servers and clients keep data in the same shape, but unprivileged clients
# will only have their own info here
PatronStore = Store({
    "patron.{patron_uuid}": Patron,
    "patrons": Setx,
})

Hold = Struct(
    id=Uuid,
    patron=Uuid,
    target=Struct(book=Uuid) | Struct(edition=Isbn),
    timestamp=Date,
    expires=Maybe(Date),
)

Checkout = Struct(
    id=Uuid,
    book=Uuid,
    patron=Uuid,
    expires=Date,
    overdue=Bool,  # server determination based on expires
)

StatusStore = Store({
    "hold.{hold_uuid}": Hold,
    "checkout.{checkout_uuid}": Checkout,
    "active_holds": Setx,
    "active_checkouts": Setx,
})

# "virtualized" hold, or maybe "view of hold", but just not the whole thing
# this is what the server's virtualization layer emits to clients.  All clients
# will see all holds but won't know who they belong to.  Also, clients will not
# have enough information to evaluate if a TryHold event is valid.
VHold = Struct(
    id=Uuid,
    target=Struct(book=Uuid) | Struct(edition=Isbn),
    timestamp=Date,
    expires=Maybe(Date),
    # contains your id or nothing
    patron=Maybe(Uuid),
    # this is only ever set to true by the userForecaster
    forecasted=Maybe(Literal(True)),
)

VCheckout = Struct(
    id=Uuid,
    book=Uuid,
    expires=Date,
    overdue=Bool,  # server determination based on expires
    # contains your id or nothing
    patron=Maybe(Uuid),
)

VStatusStore = Store({
    "hold.{hold_uuid}": VHold,
    "checkout.{checkout_uuid}": VCheckout,
})

# Now construct the Stores themselves.  Different system components have
# different compositions of store.

# The decider needs all state data, plus an output to store generated events:
# - all book data,
# - all patron data,
# - all status data,
# - a single key for new decider events
DeciderEvents = Union()  # we'll populate this union later
DeciderStore = Store(
    BookStore,
    PatronStore,
    StatusStore,
    {"decider_events": Array(DeciderEvents)},
)

# The (unprivileged) user client will need:
# - all book data
# - a shard of the patron data, which is really just themselves
#    - this can conveniently be typed the same as the full patron data
# - all virtualized status data
# - a place to store UI messages that originate in the reducers
UserStore = Store(BookStore, PatronStore, VStatusStore, {
    "messages": Array(String),
})

# The admin client will need all state, but it relies on State, not VState
AdminStore = Store(BookStore, PatronStore, StatusStore)

#################
## Event Layer ##
#################

# list of streams:
# - books: all edition and book-related info
# - patron.{patron_uuid}: all patron info, per-patron
# - status: privileged stream of all checkpoints and holds
# - vstatus: status decisions; relay will scrub and filter before forwarding to users
#
# extra streams:
# - deciderState: where the decider stores its checkpoint data

BookEvents = Union()

# editions: globally visible
# stream: "books"
AddEdition = BookEvents.add(Struct(
    type=Literal("add-edition"),
    isbn=Isbn,
    title=String,
    timestamp=Date,
))

# stream: "books"
UpdateEditionTitle = BookEvents.add(Struct(
    type=Literal("update-edition-title"),
    isbn=Isbn,
    title=String,
    timestamp=Date,
))

# books: globally visible

# stream: "books"
AddBook = BookEvents.add(Struct(
    type=Literal("add-book"),
    id=Uuid,
    isbn=Isbn,
    restricted=Bool,
    timestamp=Date,
))

# stream: "books"
UpdateBookRestricted = BookEvents.add(Struct(
    type=Literal("update-book-restricted"),
    id=Uuid,
    restricted=Bool,
    timestamp=Date,
))

# stream: "books"
RemoveBook = BookEvents.add(Struct(
    type=Literal("remove-book"),
    id=Uuid,
    timestamp=Date,
))

# patrons: same data in frontend and backend, but client can only view self

PatronEvents = Union()

# stream: "patron.{patron_uuid}"
AddPatron = PatronEvents.add(Struct(
    type=Literal("add-patron"),
    id=Uuid,
    name=String,
    researcher=Bool,
    timestamp=Date,
))

# stream: "patron.{patron_uuid}"
RenamePatron = PatronEvents.add(Struct(
    type=Literal("rename-patron"),
    id=Uuid,
    name=String,
    timestamp=Date,
))

# stream: "patron.{patron_uuid}"
AssignPatron = PatronEvents.add(Struct(
    type=Literal("assign-patron"),
    id=Uuid,
    researcher=Bool,
    timestamp=Date,
))

StatusEvents = Union()

# holds: fully visible to hold owners; partially visible globally

# stream: "status"
TryHold = StatusEvents.add(Struct(
    type=Literal("try-hold"),
    id=Uuid,
    patron=Uuid,
    # can hold a specific book or just any generic one
    target=Struct(book=Uuid) | Struct(edition=Isbn),
    open=Bool,
    timestamp=Date,
))

# stream: "status"
CancelHold = StatusEvents.add(Struct(
    type=Literal("cancel-hold"),
    id=Uuid,
))

# system-generated event
# stream: "status"
ExpireHold = StatusEvents.add(Struct(
    type=Literal("expire-hold"),
    id=Uuid,
    timestamp=Date,
))

# checkouts: fully visible to hold owners; partially visible globally

# only valid if it appears valid when reading the log
# automatically cancels the relevant hold
# stream: "status"
TryCheckout = StatusEvents.add(Struct(
    type=Literal("try-checkout"),
    id=Uuid,
    patron=Uuid,
    book=Uuid,
    timestamp=Date,
))

# stream: "status"
EndCheckout = StatusEvents.add(Struct(
    type=Literal("end-checkout"),
    checkout=Uuid,
    timestamp=Date,
))

# system-generated event
# stream: "status"
OverdueCheckout = StatusEvents.add(Struct(
    type=Literal("overdue-checkout"),
    checkout=Uuid,
    timestamp=Date,
))

# virtualized status (or "view of" status): sanitized data for clients to view.
#
# In the backend, hold decisions are determined by the order in which TryHolds
# arrive, relative to other holds, checkouts, and even assign-patron events.
# But since clients can't know about each other, a virtualization layer is
# necessary to tell clients about the hold decisions without exposing all the
# data required to make those decisions.

# stream: "vstatus"
NewVHold = DeciderEvents.add(Struct(
    type=Literal("new-vhold"),
    id=Uuid,
    target=Struct(book=Uuid) | Struct(edition=Isbn),
    open=Bool,
    expires=Maybe(Date),
    timestamp=Date,
    # DB stores patron, but the server strips it before streaming it to clients.
    patron=Maybe(Uuid),
    # this is only ever set to true by the userForecaster
    forecasted=Maybe(Literal(True)),
))

# Similarly, since clients cannot have enough information to make hold decisions
# on their own, they must be alerted to when their own holds were rejected.
# stream: "vstatus"
VHoldRejected = DeciderEvents.add(Struct(
    type=Literal("vhold-rejected"),
    id=Uuid,
    reason=String,
    # A client will only see vhold-rejected for holds it has itself requested, so
    # from the client perspective, `patron` will always be its own patron id
    patron=Uuid,
))

# If a patron is demoted, their now-invalid holds get canceled by the system.  Other patrons won't
# see the demotion so we need to broadcast this.
EndVHold = DeciderEvents.add(Struct(
    type=Literal("end-vhold"),
    id=Uuid,
    timestamp=Date,
))

# Similar to NewVHold, but for checkouts.
# stream: "vstatus"
NewVCheckout = DeciderEvents.add(Struct(
    type=Literal("new-vcheckout"),
    id=Uuid,
    book=Uuid,
    expires=Date,
    # DB stores patron, but the server strips it before streaming it to clients.
    patron=Maybe(Uuid),
))

# Note: there is no VCheckoutRejected because only the front desk, which has
# admin privileges, can create checkouts in the first place.

# union of all state-related events
LibraryEvents = BookEvents | PatronEvents | StatusEvents | DeciderEvents

DeciderFramework = Framework(LibraryEvents, LibraryEvents, DeciderStore)

################

# A patron has very limited write capabilities.  Each of these events may be written but only to
# their own patron_uuid.
UserCommands = (
    RenamePatron
    | TryHold
    | CancelHold
)

UserFramework = Framework(LibraryEvents, UserCommands, UserStore)

# An admin (the librarian at the front desk) has most of the write capabilities in the system,
# except they cannot create decider-specific events.
AdminCommands = (
    # admin can create UserCommands with whatever patron_uuid they want
    UserCommands
    | AddEdition
    | UpdateEditionTitle
    | AddBook
    | UpdateBookRestricted
    | RemoveBook
    | AddPatron
    | AssignPatron
    | TryCheckout
    | EndCheckout
)

AdminFramework = Framework(LibraryEvents, AdminCommands, AdminStore)

# ok, technically UserCommands is a subset of AdminCommands, but this expresses that the relay is
# going to relay commands from both types of clients.
RelayCommands = Alias(UserCommands | AdminCommands)

RelayHold = Struct(patron=Uuid)

# The relay is mostly concerned with checking that all uuid references are valid, so it doesn't
# have a lot of overlap with the storage layout of the decider or the ui
RelayStore = Store({
    "edition.{isbn}": Literal(True),
    "book.{book_uuid}": Literal(True),
    "patron.{hold_uuid}": Literal(True),
    "checkout.{checkout_uuid}": Literal(True),
    "hold.{hold_uuid}": RelayHold,
})

RelayFramework = Framework(LibraryEvents, RelayCommands, RelayStore)
