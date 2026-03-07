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

class Timestamp(Concrete):
    json_type = "string"

    def __str__(self):
        return "timestamp"

    @staticmethod
    def ts_generate_annotation(d, annos, visit):
        return "Date"

    @staticmethod
    def ts_generate_decoder(d, annos, decoders, visit):
        return lambda val: f"new Date({val} as string)"

    @staticmethod
    def py_generate_annotation(d, annos, visit, path):
        return "datetime.datetime"

    @staticmethod
    def py_generate_checker(d, annos, decoders, visit):
        return lambda val, path: (
            "try:\n"
            f"    datetime.datetime.strptime({val}, '%Y-%m-%dT%H:%M:%SZ')\n"
            "except ValueError:\n"
            f"    problems += [{path} + ': invalid timestamp']\n"
        )
        # encoder example:
        # datetime.datetime.now().astimezone(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

    @staticmethod
    def go_generate_type(d, imports, annos, converters, visit, path):
        imports["time"] = None
        imports["fmt"] = None
        d.print("\nfunc NewTimestamp(value goja.Value) time.Time {\n")
        d.indent("\t")
        d.print('strtime := value.Export().(string)\n')
        d.print('out, err := time.Parse("2006-01-02T15:04:05Z", strtime)\n')
        d.print('if err != nil {\n')
        d.indent("\t")
        d.print('panic(fmt.Sprintf("invalid timestamp (%v): %v", strtime, err))\n')
        d.dedent()
        d.print('}\n')
        d.print('return out\n')
        d.dedent()
        d.print("}\n")
        return "time.Time", lambda var: f"NewTimestamp({var})"

    @staticmethod
    def go_generate_checker(d, annos, decoders, visit):
        return lambda var, path: (
            f'if strtime, ok := {var}.Export().(string); !ok {{\n'
            f'\terrs = append(errs, fmt.Errorf("%v: not a string", {path}))\n'
            f'}} else if _, err := time.Parse("2006-01-02T15:04:05Z", strtime); err != nil {{\n'
            f'\terrs = append(errs, fmt.Errorf("%v: not a valid timestamp: %w", {path}, err))\n'
            f'}}\n'
        )

###################
## Storage Layer ##
###################

Uuid = Alias(String)
Isbn = Alias(String)
Set = Object(Literal(True))

Edition = Struct(
    isbn=Isbn,
    title=String,
    books=Set,
    # edition-level holds
    holds=Set,
)

Book = Struct(
    id=Uuid,
    isbn=Isbn,
    restricted=Bool,
    # book-level holds and checkouts
    status=Maybe(Struct(hold=Uuid) | Struct(checkout=Uuid)),
)

# servers and clients keep the same data
BookStore = Store({
    "edition.{edition_isbn}": Edition,
    "editions": Set,
    "book.{book_uuid}": Book,
})

Patron = Struct(
    id=Uuid,
    name=String,
    researcher=Bool,
    checkouts=Set,
    holds=Set,
)

# servers and clients keep data in the same shape, but clients will only have
# their own info here
PatronStore = Store({
    "patron.{patron_uuid}": Patron,
    "patrons": Set,
})

Hold = Struct(
    id=Uuid,
    patron=Uuid,
    target=Struct(book=Uuid) | Struct(edition=Isbn),
    expires=Maybe(Timestamp),
)

Checkout = Struct(
    id=Uuid,
    book=Uuid,
    patron=Uuid,
    expires=Timestamp,
    overdue=Bool,  # server determination based on expires
)

StatusStore = Store({
    "hold.{hold_uuid}": Hold,
    "checkout.{checkout_uuid}": Checkout,
    "active_holds": Set,
    "active_checkouts": Set,
})

# "virtualized" hold, or maybe "view of hold", but just not the whole thing
# this is what the server's virtualization layer emits to clients.  All clients
# will see all holds but won't know who they belong to.  Also, clients will not
# have enough information to evaluate if a TryHold event is valid.
VHold = Struct(
    id=Uuid,
    target=Struct(book=Uuid) | Struct(edition=Isbn),
    expires=Maybe(Timestamp),
    # contains your id or nothing
    patron=Maybe(Uuid),
)

VCheckout = Struct(
    id=Uuid,
    book=Uuid,
    expires=Timestamp,
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

# The (unprivileged) client will need:
# - all book data
# - a shard of the patron data, which is really just themselves
#    - this can conveniently be typed the same as the full patron data
# - all virtualized status data for
UserStore = Store(BookStore, PatronStore, VStatusStore)

#################
## Event Layer ##
#################

BookEvents = Union()

# editions: globally visible
AddEdition = BookEvents.add(Struct(
    type=Literal("add-edition"),
    isbn=Isbn,
    title=String,
    timestamp=Timestamp,
))

UpdateEditionTitle = BookEvents.add(Struct(
    type=Literal("update-edition-title"),
    isbn=Isbn,
    title=String,
    timestamp=Timestamp,
))

# books: globally visible

AddBook = BookEvents.add(Struct(
    type=Literal("add-book"),
    id=Uuid,
    isbn=Isbn,
    restricted=Bool,
    timestamp=Timestamp,
))

UpdateBookRestricted = BookEvents.add(Struct(
    type=Literal("update-book-restricted"),
    id=Uuid,
    restricted=Bool,
    timestamp=Timestamp,
))

RemoveBook = BookEvents.add(Struct(
    type=Literal("remove-book"),
    id=Uuid,
    timestamp=Timestamp,
))

# patrons: same data in frontend and backend, but client can only view self

PatronEvents = Union()

AddPatron = PatronEvents.add(Struct(
    type=Literal("add-patron"),
    id=Uuid,
    name=String,
    researcher=Bool,
    timestamp=Timestamp,
))

RenamePatron = PatronEvents.add(Struct(
    type=Literal("rename-patron"),
    id=Uuid,
    name=String,
    timestamp=Timestamp,
))

AssignPatron = PatronEvents.add(Struct(
    type=Literal("assign-patron"),
    id=Uuid,
    researcher=Bool,
    timestamp=Timestamp,
))

StatusEvents = Union()

# holds: fully visible to hold owners; partially visible globally

TryHold = StatusEvents.add(Struct(
    type=Literal("try-hold"),
    id=Uuid,
    patron=Uuid,
    # can hold a specific book or just any generic one
    target=Struct(book=Uuid) | Struct(edition=Isbn),
    open=Bool,
    timestamp=Timestamp,
))

CancelHold = StatusEvents.add(Struct(
    type=Literal("cancel-hold"),
    hold=Uuid,
))

ExpireHold = StatusEvents.add(Struct(
    type=Literal("expire-hold"),
    hold=Uuid,
    timestamp=Timestamp,
))

# checkouts: fully visible to hold owners; partially visible globally

# only valid if it appears valid when reading the log
# automatically cancels the relevant hold
TryCheckout = StatusEvents.add(Struct(
    type=Literal("try-checkout"),
    id=Uuid,
    patron=Uuid,
    book=Uuid,
    timestamp=Timestamp,
))

EndCheckout = StatusEvents.add(Struct(
    type=Literal("end-checkout"),
    checkout=Uuid,
    timestamp=Timestamp,
))

# system-generated event
OverdueCheckout = StatusEvents.add(Struct(
    type=Literal("overdue-checkout"),
    checkout=Uuid,
    timestamp=Timestamp,
))

# virtualized status (or "view of" status): sanitized data for clients to view.
#
# In the backend, hold decisions are determined by the order in which TryHolds
# arrive, relative to other holds, checkouts, and even assign-patron events.
# But since clients can't know about each other, a virtualization layer is
# necessary to tell clients about the hold decisions without exposing all the
# data required to make those decisions.

NewVHold = DeciderEvents.add(Struct(
    type=Literal("new-vhold"),
    id=Uuid,
    target=Struct(book=Uuid) | Struct(edition=Isbn),
    open=Bool,
    expires=Maybe(Timestamp),
    timestamp=Timestamp,
    # DB stores patron, but the server strips it before streaming it to clients.
    patron=Maybe(Uuid),
))

# Similarly, since clients cannot have enough information to make hold decisions
# on their own, they must be alerted to when their own holds were rejected.
VHoldRejected = DeciderEvents.add(Struct(
    type=Literal("vhold-rejected"),
    id=Uuid,
    reason=String,
))

# Similar to NewVHold, but for checkouts.
NewVCheckout = DeciderEvents.add(Struct(
    type=Literal("new-vcheckout"),
    id=Uuid,
    book=Uuid,
    expires=Timestamp,
    # DB stores patron, but the server strips it before streaming it to clients.
    patron=Maybe(Uuid),
))

# Note: there is no VCheckoutRejected because only the front desk, which has
# admin privileges, can create checkouts in the first place.

# VStatusEvents are the StatusEvents which need no sanitation plus DeciderEvents
VStatusEvents = (
    CancelHold | ExpireHold | EndCheckout | OverdueCheckout | DeciderEvents
)

# utility of all possible events
LibraryEvents = BookEvents | PatronEvents | StatusEvents | DeciderEvents

# predefine some frameworks
UserFramework = Framework(LibraryEvents, LibraryEvents, UserStore)
DeciderFramework = Framework(LibraryEvents, LibraryEvents, DeciderStore)
