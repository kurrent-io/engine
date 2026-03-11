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

// import { ProjectorGenerator } from './skeleton';

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
  BookProjectorContext,
  PatronProjectorContext,
  StatusProjectorContext,
  VStatusProjectorContext,
  DeciderProjectorContext,
  UserProjectorContext,

  ProjectorGenerator,
} from './library.gen';


type BooksPX = typeof BookProjectorContext;

function *projectAddEdition(px: BooksPX, e: AddEdition): ProjectorGenerator<void> {
  // add this edition
  yield* px.set.edition(e.isbn, {
    isbn: e.isbn,
    title: e.title,
    books: {},
    holds: {},
  });
  // create new edition
  const editions = (yield* px.get.editions()) ?? {}; // TODO: maybe formalize migrations somehow?
  editions[e.isbn] = true;
  yield* px.set.editions(editions);
}

function *projectUpdateEditionTitle(px: BooksPX, e: UpdateEditionTitle): ProjectorGenerator<void> {
  const edition = yield* px.get.edition(e.isbn);
  edition.title = e.title;
  yield* px.set.edition(e.isbn, edition);
}

function *projectAddBook(px: BooksPX, e: AddBook): ProjectorGenerator<void> {
  // create new book
  yield* px.set.book(e.id, {
    id: e.id,
    isbn: e.isbn,
    restricted: e.restricted,
  });
  // add book to edition
  const edition = yield* px.get.edition(e.isbn);
  edition.books[e.id] = true
  yield* px.set.edition(e.isbn, edition);
}

function *projectUpdateBookRestricted(px: BooksPX, e: UpdateBookRestricted): ProjectorGenerator<void> {
  const book = yield* px.get.book(e.id);
  book.restricted = e.restricted;
  yield* px.set.book(e.id, book);
}

function *projectRemoveBook(px: BooksPX, e: RemoveBook): ProjectorGenerator<void> {
  const book = yield* px.get.book(e.id);
  yield* px.del.book(e.id);
  // just remove from edition
  const edition = yield* px.get.edition(book.isbn);
  delete edition.books[e.id];
  yield* px.set.edition(book.isbn, edition);
}

type PatronsPX = typeof PatronProjectorContext;

function *projectAddPatron(px: PatronsPX, e: AddPatron): ProjectorGenerator<void> {
  yield* px.set.patron(e.id, {
    id: e.id,
    name: e.name,
    researcher: e.researcher,
    checkouts: {},
    holds: {},
  });
}

function *projectRenamePatron(px: PatronsPX, e: RenamePatron): ProjectorGenerator<void> {
  const patron = yield* px.get.patron(e.id);
  patron.name = e.name;
  yield* px.set.patron(e.id, patron);
}

// returns nowInvalidHolds
function *projectAssignPatron(px: PatronsPX, e: AssignPatron): ProjectorGenerator<string[]> {
  const patron = yield* px.get.patron(e.id);
  patron.researcher = e.researcher;
  // check for now-invalid holds
  const invalidHolds: string[] = [];
  for (const hold_uuid of Object.keys(patron.holds)) {
    const hold = yield* (px as any).get.hold(hold_uuid);  // TODO: fix types
    if ("edition" in hold.target) continue;
    const book = yield* (px as any).get.book(hold.target.book); // TODO: fix types
    if (!book.restricted) continue;
    invalidHolds.push(hold_uuid);
  }
  yield* px.set.patron(e.id, patron);
  return invalidHolds;
}

type StatusPX = typeof StatusProjectorContext & PatronsPX & BooksPX;

// returns rejection reason, or an empty string
function *projectTryHold(px: StatusPX, e: TryHold): ProjectorGenerator<string> {
  // patron checks
  const patron = yield* px.get.patron(e.id);
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
    const checkout = yield* px.get.checkout(checkout_uuid);
    if (checkout.overdue) overdue++;
  }
  if (overdue >= 2) {
    return "too many overdue checkouts";
  }

  let isbn: string;
  if ("book" in e.target) {
    // hold is targeting a specific book
    const book = yield* px.get.book(e.target.book);
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
  const edition = yield* px.get.edition(isbn);
  const books: Book[] = [];
  for (const book_uuid of Object.keys(edition.books)) {
    const book = yield* px.get.book(book_uuid);
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
  yield* px.set.hold(e.id, hold);

  if ("book" in e.target) {
    // add the hold to this book
    const book = yield* px.get.book(e.target.book);
    book.status = { hold: hold.id };
    yield* px.set.book(e.target.book, book);
  } else {
    // add the hold to this edition
    edition.holds[hold.id] = true;
    yield* px.set.edition(e.target.edition, edition);
  }

  // TODO: update patron.holds
  // TODO: update active_holds

  return "";
}

function *projectEndHold(px: StatusPX, e: CancelHold|ExpireHold): ProjectorGenerator<void> {
  // look up the hold
  const hold = yield* px.get.hold(e.hold);
  // be idempotent
  if (!hold) return;
  // delete the hold
  yield* px.del.hold(e.hold);
  // update hold target (book or edition)
  if ("book" in hold.target) {
    const book = yield* px.get.book(hold.target.book);
    delete book.status;
    yield* px.set.book(hold.target.book, book);
  } else {
    const edition = yield* px.get.edition(hold.target.edition);
    delete edition.holds[e.hold]
    yield* px.set.edition(hold.target.edition, edition);
  }
  // update patron
  const patron = yield* px.get.patron(hold.patron);
  delete patron.holds[hold.id];
  yield* px.set.patron(hold.patron, patron);
  // update active holds
  const active_holds = yield* px.get.active_holds();
  delete active_holds[e.hold];
  yield* px.set.active_holds(active_holds);
}

// returns rejection reason, or an empty string
function *projectTryCheckout(px: StatusPX, e: TryCheckout): ProjectorGenerator<string> {
  /* the domain description does not mention if hold limits and overdue restrictions
     apply to checkouts, but let us assume that they do */

  const patron = yield* px.get.patron(e.patron);
  const book = yield* px.get.book(e.book);
  const edition = yield* px.get.edition(book.isbn);

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
    const checkout = yield* px.get.checkout(checkout_uuid);
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
        const book = yield* px.get.book(book_uuid);
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
  yield* px.set.checkout(e.id, checkout);

  // update edition if there was an edition-level hold
  if (ourHold && ourHold in edition.holds) {
    delete edition.holds[ourHold];
    yield* px.set.edition(book.isbn, edition);
  }

  // update book
  book.status = { checkout: e.id };
  yield* px.set.book(e.book, book);

  // update patron
  if (ourHold) delete patron.holds[ourHold];
  patron.checkouts[checkout.id] = true;
  yield* px.set.patron(e.patron, patron);

  // TODO: update active_checkouts

  return "";
}

function *projectEndCheckout(px: StatusPX, e: EndCheckout): ProjectorGenerator<void> {
  const checkout = yield* px.get.checkout(e.checkout);
  /* no need for idempotency; only the front desk can end a checkout and that system should
     guarantee exactly-once behavior */
  yield* px.del.checkout(e.checkout);
  // update book
  const book = yield* px.get.book(checkout.book);
  delete book.status;
  yield* px.set.book(checkout.book, book);
  // update patron
  const patron = yield* px.get.patron(checkout.patron);
  delete patron.checkouts[checkout.id];
  yield* px.set.patron(checkout.patron, patron);
  // update active checkouts
  const active_checkouts = yield* px.get.active_checkouts();
  delete active_checkouts[e.checkout];
  yield* px.set.active_checkouts(active_checkouts);
}

// reusable for either status or vstatus stores
function *projectOverdueCheckout(
  px: typeof StatusProjectorContext | typeof VStatusProjectorContext,
  e: OverdueCheckout,
): ProjectorGenerator<void> {
  const checkout = yield* (px as any).get.checkout(e.checkout); // TODO: fix types
  checkout.overdue = true
  yield* px.set.checkout(e.checkout, checkout);
}

type VStatusPX = typeof VStatusProjectorContext & BooksPX & PatronsPX;

function *projectNewVHold(px: VStatusPX, e: NewVHold): ProjectorGenerator<void> {
  const hold: VHold = {
    id: e.id,
    target: e.target,
  };
  if (e.patron) hold.patron = e.patron;
  yield* px.set.hold(e.id, hold);
}

function *projectVHoldRejected(px: VStatusPX, e: VHoldRejected): ProjectorGenerator<void> {
  // TODO: handle this
  console.log(px, e);
}

function *projectVEndHold(px: VStatusPX, e: CancelHold|ExpireHold): ProjectorGenerator<void> {
  // look up the hold
  const hold = yield* px.get.hold(e.hold);
  // be idempotent
  if (!hold) return;
  // delete the hold
  yield* px.del.hold(e.hold);
  // update hold target (book or edition)
  if ("book" in hold.target) {
    const book = yield* px.get.book(hold.target.book);
    delete book.status;
    yield* px.set.book(hold.target.book, book);
  } else {
    const edition = yield* px.get.edition(hold.target.edition);
    delete edition.holds[e.hold]
    yield* px.set.edition(hold.target.edition, edition);
  }
  // update patron
  if (hold.patron) {
    const patron = yield* px.get.patron(hold.patron);
    delete patron.holds[hold.id];
    yield* px.set.patron(hold.patron, patron);
  }
}

function *projectNewVCheckout(px: VStatusPX, e: NewVCheckout): ProjectorGenerator<void> {
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
    const patron = yield* px.get.patron(e.patron);
    patron.checkouts[e.id] = true;
    yield* px.set.patron(e.patron, patron);
  }
  yield* px.set.checkout(e.id, checkout);
}

function *projectVEndCheckout(px: VStatusPX, e: EndCheckout): ProjectorGenerator<void> {
  const checkout = yield* px.get.checkout(e.checkout);
  /* no need for idempotency; only the front desk can end a checkout and that system should
     guarantee exactly-once behavior */
  yield* px.del.checkout(e.checkout);
  // update book
  const book = yield* px.get.book(checkout.book);
  delete book.status;
  yield* px.set.book(checkout.book, book);
  // update patron
  if (checkout.patron) {
    const patron = yield* px.get.patron(checkout.patron);
    delete patron.checkouts[checkout.id];
    yield* px.set.patron(checkout.patron, patron);
  }
}

/* ---------------------- */

export function *deciderProjector(
  px: typeof DeciderProjectorContext, events: LibraryEvents[],
): ProjectorGenerator<void> {
  const deciderEvents: DeciderEvents[] = [];

  for (const e of events) {
    switch(e.type){
      case "add-edition":            yield* projectAddEdition(px, e);           break;
      case "update-edition-title":   yield* projectUpdateEditionTitle(px, e);   break;
      case "add-book":               yield* projectAddBook(px, e);              break;
      case "update-book-restricted": yield* projectUpdateBookRestricted(px, e); break;
      case "remove-book":            yield* projectRemoveBook(px, e);           break;

      case "add-patron":    yield* projectAddPatron(px, e);    break;
      case "rename-patron": yield* projectRenamePatron(px, e); break;
      case "assign-patron": {
        const invalidHolds = yield* projectAssignPatron(px, e);
        for (const hold_uuid of invalidHolds) {
          const hold = yield* px.get.hold(hold_uuid);
          if ("book" in hold.target) {
            // update book as not held
            const book = yield* px.get.book(hold.target.book);
            delete book.status;
            yield* px.set.book(hold.target.book, book);
          } else {
            // remove a hold from the edition
            const edition = yield* px.get.edition(hold.target.edition);
            delete edition.holds[hold.id];
            yield* px.set.edition(hold.target.edition, edition);
          }
          // remove hold from patron
          const patron = yield* px.get.patron(hold.patron);
          delete patron.holds[hold_uuid];
          // delete this hold
          yield* px.del.hold(hold_uuid);
        }
      } break;

      case "cancel-hold":      // fallthru
      case "expire-hold":      yield* projectEndHold(px, e);         break;
      case "end-checkout":     yield* projectEndCheckout(px, e);     break;
      case "overdue-checkout": yield* projectOverdueCheckout(px, e); break;
      case "try-hold": {
        const rejected = yield* projectTryHold(px, e);
        if (rejected) {
          deciderEvents.push({ type: "vhold-rejected", id: e.id, reason: rejected });
        } else {
          // TODO: needs expiration too, I think.
          deciderEvents.push({ ...e, type: "new-vhold" });
        }
      } break;
      case "try-checkout": {
        const rejected = yield* projectTryCheckout(px, e);
        if (rejected) {
          // note: there is no VCheckoutRejected event needed in the system
        } else {
          // steal .expires from reach checkout
          const checkout = yield* px.get.checkout(e.id);
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
  yield* px.set.decider_events(deciderEvents);
}

// client composition
export function *userProjector(
  px: typeof UserProjectorContext, events: LibraryEvents[],
): ProjectorGenerator<void> {
  for (const e of events) {
    // extend read model
    switch(e.type){
      case "add-edition":            yield* projectAddEdition(px, e);           break;
      case "update-edition-title":   yield* projectUpdateEditionTitle(px, e);   break;
      case "add-book":               yield* projectAddBook(px, e);              break;
      case "update-book-restricted": yield* projectUpdateBookRestricted(px, e); break;
      case "remove-book":            yield* projectRemoveBook(px, e);           break;

      case "add-patron":    yield* projectAddPatron(px, e);    break;
      case "rename-patron": yield* projectRenamePatron(px, e); break;
      case "assign-patron": yield* projectAssignPatron(px, e); break;

      case "new-vhold":        yield* projectNewVHold(px, e);        break;
      case "vhold-rejected":   yield* projectVHoldRejected(px, e);   break;
      case "cancel-hold":      // fallthru
      case "expire-hold":      yield* projectVEndHold(px, e);        break;
      case "new-vcheckout":    yield* projectNewVCheckout(px, e);    break;
      case "end-checkout":     yield* projectVEndCheckout(px, e);    break;
      case "overdue-checkout": yield* projectOverdueCheckout(px, e); break;

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
