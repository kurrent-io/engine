/*

from: https://github.com/ddd-by-examples/library

A public library allows patrons to place books on hold at its various library branches. Available
books can be placed on hold only by one patron at any given point in time. Books are either
circulating or restricted, and can have retrieval or usage fees. A restricted book can only be held
by a researcher patron. A regular patron is limited to five holds at any given moment, while a
researcher patron is allowed an unlimited number of holds. An open-ended book hold is active until
the patron checks out the book, at which time it is completed. A closed-ended book hold that is not
completed within a fixed number of days after it was requested will expire. This check is done at
the beginning of a day by taking a look at daily sheet with expiring holds. Only a researcher patron
can request an open-ended hold duration. Any patron with more than two overdue checkouts at a
library branch will get a rejection if trying a hold at that same library branch. A book can be
checked out for up to 60 days. Check for overdue checkouts is done by taking a look at daily sheet
with overdue checkouts. Patron interacts with his/her current holds, checkouts, etc. by taking a
look at patron profile. Patron profile looks like a daily sheet, but the information there is
limited to one patron and is not necessarily daily. Currently a patron can see current holds (not
canceled nor expired) and current checkouts (including overdue).  Also, he/she is able to hold a
book and cancel a hold.

How actually a patron knows which books are there to lend? Library has its catalogue of books where
books are added together with their specific instances. A specific book instance of a book can be
added only if there is book with matching ISBN already in the catalogue. Book must have non-empty
title and price. At the time of adding an instance we decide whether it will be Circulating or
Restricted. This enables us to have book with same ISBN as circulated and restricted at the same
time (for instance, there is a book signed by the author that we want to keep as Restricted)

*/

// import { ReducerGenerator } from './skeleton';

import {
  Book,
  Hold,
  VHold,
  VCheckout,
  NewVHold,
  VHoldRejected,
  NewVCheckout,
  DeciderEvents,
  AddEdition,
  UpdateEditionTitle,
  AddBook,
  UpdateBookRestricted,
  RemoveBook,
  AddPatron,
  RenamePatron,
  AssignPatron,
  TryHold,
  CancelHold,
  ExpireHold,
  TryCheckout,
  EndCheckout,
  OverdueCheckout,
  LibraryEvents,
  BookReducerContext,
  PatronReducerContext,
  StatusReducerContext,
  VStatusReducerContext,
  DeciderReducerContext,
  UserReducerContext,

  ReducerGenerator,
} from './library.gen';


type BooksRX = typeof BookReducerContext;

function *reduceAddEdition(rx: BooksRX, e: AddEdition): ReducerGenerator<void> {
  // add this edition
  yield* rx.set.edition(e.isbn, {
    isbn: e.isbn,
    title: e.title,
    books: {},
    holds: {},
  });
  // create new edition
  const editions = (yield* rx.get.editions()) ?? {}; // TODO: maybe formalize migrations somehow?
  editions[e.isbn] = true;
  yield* rx.set.editions(editions);
}

function *reduceUpdateEditionTitle(rx: BooksRX, e: UpdateEditionTitle): ReducerGenerator<void> {
  const edition = yield* rx.get.edition(e.isbn);
  edition.title = e.title;
  yield* rx.set.edition(e.isbn, edition);
}

function *reduceAddBook(rx: BooksRX, e: AddBook): ReducerGenerator<void> {
  // create new book
  yield* rx.set.book(e.id, {
    id: e.id,
    isbn: e.isbn,
    restricted: e.restricted,
  });
  // add book to edition
  const edition = yield* rx.get.edition(e.isbn);
  edition.books[e.id] = true
  yield* rx.set.edition(e.isbn, edition);
}

function *reduceUpdateBookRestricted(rx: BooksRX, e: UpdateBookRestricted): ReducerGenerator<void> {
  const book = yield* rx.get.book(e.id);
  book.restricted = e.restricted;
  yield* rx.set.book(e.id, book);
}

function *reduceRemoveBook(rx: BooksRX, e: RemoveBook): ReducerGenerator<void> {
  const book = yield* rx.get.book(e.id);
  yield* rx.del.book(e.id);
  // just remove from edition
  const edition = yield* rx.get.edition(book.isbn);
  delete edition.books[e.id];
  yield* rx.set.edition(book.isbn, edition);
}

type PatronsRX = typeof PatronReducerContext;

function *reduceAddPatron(rx: PatronsRX, e: AddPatron): ReducerGenerator<void> {
  yield* rx.set.patron(e.id, {
    id: e.id,
    name: e.name,
    researcher: e.researcher,
    checkouts: {},
    holds: {},
  });
}

function *reduceRenamePatron(rx: PatronsRX, e: RenamePatron): ReducerGenerator<void> {
  const patron = yield* rx.get.patron(e.id);
  patron.name = e.name;
  yield* rx.set.patron(e.id, patron);
}

// returns nowInvalidHolds
function *reduceAssignPatron(rx: PatronsRX, e: AssignPatron): ReducerGenerator<string[]> {
  const patron = yield* rx.get.patron(e.id);
  patron.researcher = e.researcher;
  // check for now-invalid holds
  const invalidHolds: string[] = [];
  for (const hold_uuid of Object.keys(patron.holds)) {
    const hold = yield* (rx as any).get.hold(hold_uuid);  // TODO: fix types
    if ("edition" in hold.target) continue;
    const book = yield* (rx as any).get.book(hold.target.book); // TODO: fix types
    if (!book.restricted) continue;
    invalidHolds.push(hold_uuid);
  }
  yield* rx.set.patron(e.id, patron);
  return invalidHolds;
}

type StatusRX = typeof StatusReducerContext & PatronsRX & BooksRX;

// returns rejection reason, or an empty string
function *reduceTryHold(rx: StatusRX, e: TryHold): ReducerGenerator<string> {
  // patron checks
  const patron = yield* rx.get.patron(e.id);
  if (!patron.researcher && e.open) {
    // non-researcher not allowed to issue open hold;
    return "non-researcher not allowed to issue open hold";
  }
  const nholds = Object.keys(patron.holds).length;
  const ncheckouts = Object.keys(patron.checkouts).length;
  if (!patron.researcher && nholds + ncheckouts >= 5) {
    return `too many holds (${nholds}) + checkouts (${ncheckouts})`
  }
  let overdue = 0;
  for (const checkout_uuid of Object.keys(patron.checkouts)) {
    const checkout = yield* rx.get.checkout(checkout_uuid);
    if (checkout.overdue) overdue++;
  }
  if (overdue >= 2) {
    return "too many overdue checkouts";
  }

  let isbn: string;
  if ("book" in e.target) {
    // hold is targeting a specific book
    const book = yield* rx.get.book(e.target.book);
    if (!patron.researcher && book.restricted){
      return "non-researcher not allowed to issue hold for restricted book";
    }
    if (book.status) {
      if ("hold" in book.status) {
        return "book is already on hold";
      }
      if ("checkout" in book.status) {
        return "book is already checked out";
      }
    }
    isbn = book.isbn;
  } else {
    // hold is targeting an edition
    isbn = e.target.edition;
  }

  // check for edition-level holds
  const edition = yield* rx.get.edition(isbn);
  const books: Book[] = [];
  for (const book_uuid of Object.keys(edition.books)) {
    const book = yield* rx.get.book(book_uuid);
    // ignore books which have book-level holds or are checked out
    // also ignore restricted books, which must be held specifically
    if (!book.status && !book.restricted) books.push(book);
  }
  if (Object.keys(edition.holds).length >= books.length) {
    return "all remaining books are already on hold";
  }

  // hold was successful!

  // create the new hold object
  const hold: Hold = {
    id: e.id,
    patron: e.patron,
    target: e.target,
  };
  if (!e.open) {
    hold.expires = new Date(e.timestamp.getTime() + 1000 * 60 * 60 * 24 * 5)
  }
  yield* rx.set.hold(e.id, hold);

  if ("book" in e.target) {
    // add the hold to this book
    const book = yield* rx.get.book(e.target.book);
    book.status = { hold: hold.id };
    yield* rx.set.book(e.target.book, book);
  } else {
    // add the hold to this edition
    edition.holds[hold.id] = true;
    yield* rx.set.edition(e.target.edition, edition);
  }

  // TODO: update patron.holds
  // TODO: update active_holds

  return "";
}

function *reduceEndHold(rx: StatusRX, e: CancelHold|ExpireHold): ReducerGenerator<void> {
  // look up the hold
  const hold = yield* rx.get.hold(e.hold);
  // be idempotent
  if (!hold) return;
  // delete the hold
  yield* rx.del.hold(e.hold);
  // update hold target (book or edition)
  if ("book" in hold.target) {
    const book = yield* rx.get.book(hold.target.book);
    delete book.status;
    yield* rx.set.book(hold.target.book, book);
  } else {
    const edition = yield* rx.get.edition(hold.target.edition);
    delete edition.holds[e.hold]
    yield* rx.set.edition(hold.target.edition, edition);
  }
  // update patron
  const patron = yield* rx.get.patron(hold.patron);
  delete patron.holds[hold.id];
  yield* rx.set.patron(hold.patron, patron);
  // update active holds
  const active_holds = yield* rx.get.active_holds();
  delete active_holds[e.hold];
  yield* rx.set.active_holds(active_holds);
}

// returns rejection reason, or an empty string
function *reduceTryCheckout(rx: StatusRX, e: TryCheckout): ReducerGenerator<string> {
  /* the domain description does not mention if hold limits and overdue restrictions
     apply to checkouts, but let us assume that they do */

  const patron = yield* rx.get.patron(e.patron);
  const book = yield* rx.get.book(e.book);
  const edition = yield* rx.get.edition(book.isbn);

  // sanity check
  if (book.status && "checkout" in book.status) {
    return "book is already checked out";
  }

  // restricted books cannot be checked out
  if (!patron.researcher && book.restricted) {
    return "book is restricted";
  }

  // does this patron have a hold on this book?
  let ourHold: string = "";
  if (book.status?.hold) {
    if (book.status.hold in patron.holds) {
      ourHold = book.status.hold;
    }
  } else {
    for (const hold of Object.keys(edition.holds)) {
      if (hold in patron.holds) {
        ourHold = hold;
        break;
      }
    }
  }

  // would this patron exceed their limit of holds + checkouts?
  if (!patron.researcher && !ourHold) {
    const nholds = Object.keys(patron.holds).length;
    const ncheckouts = Object.keys(patron.checkouts).length;
    if (nholds + ncheckouts >= 5) {
      // too many holds; ignore
      return `too many holds (${nholds}) + checkouts (${ncheckouts})`;
    }
  }

  // does this patron have too many overdue checkouts?
  let overdue = 0;
  for (const checkout_uuid of Object.keys(patron.checkouts)) {
    const checkout = yield* rx.get.checkout(checkout_uuid);
    if (checkout.overdue) overdue++;
  }
  if (overdue >= 2) {
    return "too many overdue checkouts";
  }

  // is book on hold by someone else?
  if (!ourHold) {
    if (book.status && "hold" in book.status) {
      return "book is on hold by someone else";
    }
    if (!book.restricted) {
      const books: Book[] = [];
      for (const book_uuid of Object.keys(edition.books)) {
        const book = yield* rx.get.book(book_uuid);
        // ignore books which have book-level holds or are checked out
        // also ignore restricted books, which must be held specifically
        if (!book.status && !book.restricted) books.push(book);
      }
      if (Object.keys(edition.holds).length >= books.length) {
        return "all remaining books are already on hold";
      }
    }
  }

  // success!

  // record a new checkout object
  const checkout = {
    id: e.id,
    book: e.book,
    patron: e.patron,
    expires: new Date(e.timestamp.getTime() + 1000 * 60 * 60 * 24 * 60),
    overdue: false,
  };
  yield* rx.set.checkout(e.id, checkout);

  // update edition if there was an edition-level hold
  if (ourHold && ourHold in edition.holds) {
    delete edition.holds[ourHold];
    yield* rx.set.edition(book.isbn, edition);
  }

  // update book
  book.status = { checkout: e.id };
  yield* rx.set.book(e.book, book);

  // update patron
  if (ourHold) delete patron.holds[ourHold];
  patron.checkouts[checkout.id] = true;
  yield* rx.set.patron(e.patron, patron);

  // TODO: update active_checkouts

  return "";
}

function *reduceEndCheckout(rx: StatusRX, e: EndCheckout): ReducerGenerator<void> {
  const checkout = yield* rx.get.checkout(e.checkout);
  /* no need for idempotency; only the front desk can end a checkout and that system should
     guarantee exactly-once behavior */
  yield* rx.del.checkout(e.checkout);
  // update book
  const book = yield* rx.get.book(checkout.book);
  delete book.status;
  yield* rx.set.book(checkout.book, book);
  // update patron
  const patron = yield* rx.get.patron(checkout.patron);
  delete patron.checkouts[checkout.id];
  yield* rx.set.patron(checkout.patron, patron);
  // update active checkouts
  const active_checkouts = yield* rx.get.active_checkouts();
  delete active_checkouts[e.checkout];
  yield* rx.set.active_checkouts(active_checkouts);
}

// reusable for either status or vstatus stores
function *reduceOverdueCheckout(
  rx: typeof StatusReducerContext | typeof VStatusReducerContext,
  e: OverdueCheckout,
): ReducerGenerator<void> {
  const checkout = yield* (rx as any).get.checkout(e.checkout); // TODO: fix types
  checkout.overdue = true
  yield* rx.set.checkout(e.checkout, checkout);
}

type VStatusRX = typeof VStatusReducerContext & BooksRX & PatronsRX;

function *reduceNewVHold(rx: VStatusRX, e: NewVHold): ReducerGenerator<void> {
  const hold: VHold = {
    id: e.id,
    target: e.target,
  };
  if (e.patron) hold.patron = e.patron;
  yield* rx.set.hold(e.id, hold);
}

function *reduceVHoldRejected(rx: VStatusRX, e: VHoldRejected): ReducerGenerator<void> {
  // TODO: handle this
  console.log(rx, e);
}

function *reduceVEndHold(rx: VStatusRX, e: CancelHold|ExpireHold): ReducerGenerator<void> {
  // look up the hold
  const hold = yield* rx.get.hold(e.hold);
  // be idempotent
  if (!hold) return;
  // delete the hold
  yield* rx.del.hold(e.hold);
  // update hold target (book or edition)
  if ("book" in hold.target) {
    const book = yield* rx.get.book(hold.target.book);
    delete book.status;
    yield* rx.set.book(hold.target.book, book);
  } else {
    const edition = yield* rx.get.edition(hold.target.edition);
    delete edition.holds[e.hold]
    yield* rx.set.edition(hold.target.edition, edition);
  }
  // update patron
  if (hold.patron) {
    const patron = yield* rx.get.patron(hold.patron);
    delete patron.holds[hold.id];
    yield* rx.set.patron(hold.patron, patron);
  }
}

function *reduceNewVCheckout(rx: VStatusRX, e: NewVCheckout): ReducerGenerator<void> {
  console.log("handling new vcheckout");
  const checkout: VCheckout = {
    id: e.id,
    book: e.book,
    expires: e.expires,
    overdue: false,
  };
  if (e.patron){
    checkout.patron = e.patron;
    // also update our patron object
    const patron = yield* rx.get.patron(e.patron);
    patron.checkouts[e.id] = true;
    yield* rx.set.patron(e.patron, patron);
  }
  yield* rx.set.checkout(e.id, checkout);
}

function *reduceVEndCheckout(rx: VStatusRX, e: EndCheckout): ReducerGenerator<void> {
  const checkout = yield* rx.get.checkout(e.checkout);
  /* no need for idempotency; only the front desk can end a checkout and that system should
     guarantee exactly-once behavior */
  yield* rx.del.checkout(e.checkout);
  // update book
  const book = yield* rx.get.book(checkout.book);
  delete book.status;
  yield* rx.set.book(checkout.book, book);
  // update patron
  if (checkout.patron) {
    const patron = yield* rx.get.patron(checkout.patron);
    delete patron.checkouts[checkout.id];
    yield* rx.set.patron(checkout.patron, patron);
  }
}

/* ---------------------- */

export function *deciderReducer(
  rx: typeof DeciderReducerContext, events: LibraryEvents[],
): ReducerGenerator<void> {
  const deciderEvents: DeciderEvents[] = [];

  for (const e of events) {
    switch(e.type){
      case "add-edition":            yield* reduceAddEdition(rx, e);           break;
      case "update-edition-title":   yield* reduceUpdateEditionTitle(rx, e);   break;
      case "add-book":               yield* reduceAddBook(rx, e);              break;
      case "update-book-restricted": yield* reduceUpdateBookRestricted(rx, e); break;
      case "remove-book":            yield* reduceRemoveBook(rx, e);           break;

      case "add-patron":    yield* reduceAddPatron(rx, e);    break;
      case "rename-patron": yield* reduceRenamePatron(rx, e); break;
      case "assign-patron": {
        const invalidHolds = yield* reduceAssignPatron(rx, e);
        for (const hold_uuid of invalidHolds) {
          const hold = yield* rx.get.hold(hold_uuid);
          if ("book" in hold.target) {
            // update book as not held
            const book = yield* rx.get.book(hold.target.book);
            delete book.status;
            yield* rx.set.book(hold.target.book, book);
          } else {
            // remove a hold from the edition
            const edition = yield* rx.get.edition(hold.target.edition);
            delete edition.holds[hold.id];
            yield* rx.set.edition(hold.target.edition, edition);
          }
          // remove hold from patron
          const patron = yield* rx.get.patron(hold.patron);
          delete patron.holds[hold_uuid];
          // delete this hold
          yield* rx.del.hold(hold_uuid);
        }
      } break;

      case "cancel-hold":      // fallthru
      case "expire-hold":      yield* reduceEndHold(rx, e);         break;
      case "end-checkout":     yield* reduceEndCheckout(rx, e);     break;
      case "overdue-checkout": yield* reduceOverdueCheckout(rx, e); break;
      case "try-hold": {
        const rejected = yield* reduceTryHold(rx, e);
        if (rejected) {
          deciderEvents.push({ type: "vhold-rejected", id: e.id, reason: rejected });
        } else {
          // TODO: needs expiration too, I think.
          deciderEvents.push({ ...e, type: "new-vhold" });
        }
      } break;
      case "try-checkout": {
        const rejected = yield* reduceTryCheckout(rx, e);
        if (rejected) {
          // note: there is no VCheckoutRejected event needed in the system
        } else {
          // steal .expires from reach checkout
          const checkout = yield* rx.get.checkout(e.id);
          deciderEvents.push({ ...e, type: "new-vcheckout", expires: checkout.expires });
        }
      } break;

      // ignored events
      case "new-vhold":
      case "vhold-rejected":
      case "new-vcheckout":
        break

      default:
        const _typecheck: never = e;
        return _typecheck;
    }
  }

  // save the deciderEvents we just created
  yield* rx.set.decider_events(deciderEvents);
}

// client composition
export function *userReducer(
  rx: typeof UserReducerContext, events: LibraryEvents[],
): ReducerGenerator<void> {
  for (const e of events) {
    // extend read model
    switch(e.type){
      case "add-edition":            yield* reduceAddEdition(rx, e);           break;
      case "update-edition-title":   yield* reduceUpdateEditionTitle(rx, e);   break;
      case "add-book":               yield* reduceAddBook(rx, e);              break;
      case "update-book-restricted": yield* reduceUpdateBookRestricted(rx, e); break;
      case "remove-book":            yield* reduceRemoveBook(rx, e);           break;

      case "add-patron":    yield* reduceAddPatron(rx, e);    break;
      case "rename-patron": yield* reduceRenamePatron(rx, e); break;
      case "assign-patron": yield* reduceAssignPatron(rx, e); break;

      case "new-vhold":        yield* reduceNewVHold(rx, e);        break;
      case "vhold-rejected":   yield* reduceVHoldRejected(rx, e);   break;
      case "cancel-hold":      // fallthru
      case "expire-hold":      yield* reduceVEndHold(rx, e);        break;
      case "new-vcheckout":    yield* reduceNewVCheckout(rx, e);    break;
      case "end-checkout":     yield* reduceVEndCheckout(rx, e);    break;
      case "overdue-checkout": yield* reduceOverdueCheckout(rx, e); break;

      // events we aren't allowed to receive
      case "try-hold":
      case "try-checkout":
        break;

      default:
        const _typecheck: never = e;
        return _typecheck;
    }
  }
}
