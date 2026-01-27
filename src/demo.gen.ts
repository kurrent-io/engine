
export type Timestamp = Date;

export type Set = Record<string, true>;

export type Edition = {isbn: string, title: string, books: Set, holds: Set};

export type Book = {id: string, isbn: string, restricted: boolean, status?: {checkout: string} | {hold: string}};

export type Patron = {id: string, name: string, researcher: boolean, checkouts: Set, holds: Set};

export type Hold = {id: string, patron: string, target: {edition: string} | {book: string}, expires?: Timestamp};

export type Checkout = {id: string, book: string, patron: string, expires: Timestamp, overdue: boolean};

export type VHold = {id: string, target: {edition: string} | {book: string}, expires?: Timestamp, patron?: string};

export type VCheckout = {id: string, book: string, expires: Timestamp, overdue: boolean, patron?: string};

export type NewVHold = {type: "new-vhold", id: string, target: {edition: string} | {book: string}, open: boolean, expires?: Timestamp, timestamp: Timestamp, patron?: string};

export type VHoldRejected = {type: "vhold-rejected", id: string, reason: string};

export type NewVCheckout = {type: "new-vcheckout", id: string, book: string, expires: Timestamp, patron?: string};

export type DeciderEvents = NewVHold | NewVCheckout | VHoldRejected;

export type AddEdition = {type: "add-edition", isbn: string, title: string, timestamp: Timestamp};

export type UpdateEditionTitle = {type: "update-edition-title", isbn: string, title: string, timestamp: Timestamp};

export type AddBook = {type: "add-book", id: string, isbn: string, restricted: boolean, timestamp: Timestamp};

export type UpdateBookRestricted = {type: "update-book-restricted", id: string, restricted: boolean, timestamp: Timestamp};

export type RemoveBook = {type: "remove-book", id: string, timestamp: Timestamp};

export type BookEvents = AddBook | AddEdition | UpdateBookRestricted | UpdateEditionTitle | RemoveBook;

export type AddPatron = {type: "add-patron", id: string, name: string, researcher: boolean, timestamp: Timestamp};

export type RenamePatron = {type: "rename-patron", id: string, name: string, timestamp: Timestamp};

export type AssignPatron = {type: "assign-patron", id: string, researcher: boolean, timestamp: Timestamp};

export type PatronEvents = RenamePatron | AssignPatron | AddPatron;

export type TryHold = {type: "try-hold", id: string, patron: string, target: {edition: string} | {book: string}, open: boolean, timestamp: Timestamp};

export type CancelHold = {type: "cancel-hold", hold: string};

export type ExpireHold = {type: "expire-hold", hold: string, timestamp: Timestamp};

export type TryCheckout = {type: "try-checkout", id: string, patron: string, book: string, timestamp: Timestamp};

export type EndCheckout = {type: "end-checkout", checkout: string, timestamp: Timestamp};

export type OverdueCheckout = {type: "overdue-checkout", checkout: string, timestamp: Timestamp};

export type StatusEvents = TryHold | ExpireHold | TryCheckout | OverdueCheckout | EndCheckout | CancelHold;

export type VStatusEvents = ExpireHold | NewVCheckout | OverdueCheckout | VHoldRejected | EndCheckout | NewVHold | CancelHold;

export type LibraryEvents = AddBook | AddEdition | AssignPatron | UpdateBookRestricted | ExpireHold | UpdateEditionTitle | CancelHold | RenamePatron | NewVCheckout | TryCheckout | OverdueCheckout | VHoldRejected | EndCheckout | AddPatron | NewVHold | RemoveBook | TryHold;

export function DecodeTimestamp(val: any): Timestamp {
  return new Date(val as string) as Timestamp;
}

export function DecodeSet(val: any): Set {
  return val as Set;
}

export function DecodeEdition(val: any): Edition {
  return val as Edition;
}

export function DecodeBook(val: any): Book {
  return val as Book;
}

export function DecodePatron(val: any): Patron {
  return val as Patron;
}

function decodeAnon0(val: any): Hold {
  const out = { ...val };
  if(val.expires) out.expires = DecodeTimestamp(val.expires);
  return out as Hold;
}

export function DecodeHold(val: any): Hold {
  return decodeAnon0(val) as Hold;
}

export function DecodeCheckout(val: any): Checkout {
  return { ...val, expires: DecodeTimestamp(val.expires) } as Checkout;
}

function decodeAnon1(val: any): VHold {
  const out = { ...val };
  if(val.expires) out.expires = DecodeTimestamp(val.expires);
  return out as VHold;
}

export function DecodeVHold(val: any): VHold {
  return decodeAnon1(val) as VHold;
}

export function DecodeVCheckout(val: any): VCheckout {
  return { ...val, expires: DecodeTimestamp(val.expires) } as VCheckout;
}

function decodeAnon2(val: any): NewVHold {
  const out = { ...val };
  if(val.expires) out.expires = DecodeTimestamp(val.expires);
  out.timestamp = DecodeTimestamp(val.timestamp);
  return out as NewVHold;
}

export function DecodeNewVHold(val: any): NewVHold {
  return decodeAnon2(val) as NewVHold;
}

export function DecodeVHoldRejected(val: any): VHoldRejected {
  return val as VHoldRejected;
}

export function DecodeNewVCheckout(val: any): NewVCheckout {
  return { ...val, expires: DecodeTimestamp(val.expires) } as NewVCheckout;
}

function decodeDeciderEvents(val: any): DeciderEvents {
  let x = val;
  x = x.type;
  switch(x){
    case "new-vhold":
      return DecodeNewVHold(val);
    case "new-vcheckout":
      return DecodeNewVCheckout(val);
    case "vhold-rejected":
      return val;
    default: throw new Error(`unexpected value: ${val}`);
  }
}

export function DecodeDeciderEvents(val: any): DeciderEvents {
  return decodeDeciderEvents(val) as DeciderEvents;
}

export function DecodeAddEdition(val: any): AddEdition {
  return { ...val, timestamp: DecodeTimestamp(val.timestamp) } as AddEdition;
}

export function DecodeUpdateEditionTitle(val: any): UpdateEditionTitle {
  return { ...val, timestamp: DecodeTimestamp(val.timestamp) } as UpdateEditionTitle;
}

export function DecodeAddBook(val: any): AddBook {
  return { ...val, timestamp: DecodeTimestamp(val.timestamp) } as AddBook;
}

export function DecodeUpdateBookRestricted(val: any): UpdateBookRestricted {
  return { ...val, timestamp: DecodeTimestamp(val.timestamp) } as UpdateBookRestricted;
}

export function DecodeRemoveBook(val: any): RemoveBook {
  return { ...val, timestamp: DecodeTimestamp(val.timestamp) } as RemoveBook;
}

function decodeBookEvents(val: any): BookEvents {
  let x = val;
  x = x.type;
  switch(x){
    case "add-book":
      return DecodeAddBook(val);
    case "add-edition":
      return DecodeAddEdition(val);
    case "update-book-restricted":
      return DecodeUpdateBookRestricted(val);
    case "update-edition-title":
      return DecodeUpdateEditionTitle(val);
    case "remove-book":
      return DecodeRemoveBook(val);
    default: throw new Error(`unexpected value: ${val}`);
  }
}

export function DecodeBookEvents(val: any): BookEvents {
  return decodeBookEvents(val) as BookEvents;
}

export function DecodeAddPatron(val: any): AddPatron {
  return { ...val, timestamp: DecodeTimestamp(val.timestamp) } as AddPatron;
}

export function DecodeRenamePatron(val: any): RenamePatron {
  return { ...val, timestamp: DecodeTimestamp(val.timestamp) } as RenamePatron;
}

export function DecodeAssignPatron(val: any): AssignPatron {
  return { ...val, timestamp: DecodeTimestamp(val.timestamp) } as AssignPatron;
}

function decodePatronEvents(val: any): PatronEvents {
  let x = val;
  x = x.type;
  switch(x){
    case "rename-patron":
      return DecodeRenamePatron(val);
    case "assign-patron":
      return DecodeAssignPatron(val);
    case "add-patron":
      return DecodeAddPatron(val);
    default: throw new Error(`unexpected value: ${val}`);
  }
}

export function DecodePatronEvents(val: any): PatronEvents {
  return decodePatronEvents(val) as PatronEvents;
}

export function DecodeTryHold(val: any): TryHold {
  return { ...val, timestamp: DecodeTimestamp(val.timestamp) } as TryHold;
}

export function DecodeCancelHold(val: any): CancelHold {
  return val as CancelHold;
}

export function DecodeExpireHold(val: any): ExpireHold {
  return { ...val, timestamp: DecodeTimestamp(val.timestamp) } as ExpireHold;
}

export function DecodeTryCheckout(val: any): TryCheckout {
  return { ...val, timestamp: DecodeTimestamp(val.timestamp) } as TryCheckout;
}

export function DecodeEndCheckout(val: any): EndCheckout {
  return { ...val, timestamp: DecodeTimestamp(val.timestamp) } as EndCheckout;
}

export function DecodeOverdueCheckout(val: any): OverdueCheckout {
  return { ...val, timestamp: DecodeTimestamp(val.timestamp) } as OverdueCheckout;
}

function decodeStatusEvents(val: any): StatusEvents {
  let x = val;
  x = x.type;
  switch(x){
    case "try-hold":
      return DecodeTryHold(val);
    case "expire-hold":
      return DecodeExpireHold(val);
    case "try-checkout":
      return DecodeTryCheckout(val);
    case "overdue-checkout":
      return DecodeOverdueCheckout(val);
    case "end-checkout":
      return DecodeEndCheckout(val);
    case "cancel-hold":
      return val;
    default: throw new Error(`unexpected value: ${val}`);
  }
}

export function DecodeStatusEvents(val: any): StatusEvents {
  return decodeStatusEvents(val) as StatusEvents;
}

function decodeVStatusEvents(val: any): VStatusEvents {
  let x = val;
  x = x.type;
  switch(x){
    case "expire-hold":
      return DecodeExpireHold(val);
    case "new-vcheckout":
      return DecodeNewVCheckout(val);
    case "overdue-checkout":
      return DecodeOverdueCheckout(val);
    case "vhold-rejected":
      return val;
    case "end-checkout":
      return DecodeEndCheckout(val);
    case "new-vhold":
      return DecodeNewVHold(val);
    case "cancel-hold":
      return val;
    default: throw new Error(`unexpected value: ${val}`);
  }
}

export function DecodeVStatusEvents(val: any): VStatusEvents {
  return decodeVStatusEvents(val) as VStatusEvents;
}

function decodeLibraryEvents(val: any): LibraryEvents {
  let x = val;
  x = x.type;
  switch(x){
    case "add-book":
      return DecodeAddBook(val);
    case "add-edition":
      return DecodeAddEdition(val);
    case "assign-patron":
      return DecodeAssignPatron(val);
    case "update-book-restricted":
      return DecodeUpdateBookRestricted(val);
    case "expire-hold":
      return DecodeExpireHold(val);
    case "update-edition-title":
      return DecodeUpdateEditionTitle(val);
    case "cancel-hold":
      return val;
    case "rename-patron":
      return DecodeRenamePatron(val);
    case "new-vcheckout":
      return DecodeNewVCheckout(val);
    case "try-checkout":
      return DecodeTryCheckout(val);
    case "overdue-checkout":
      return DecodeOverdueCheckout(val);
    case "vhold-rejected":
      return val;
    case "end-checkout":
      return DecodeEndCheckout(val);
    case "add-patron":
      return DecodeAddPatron(val);
    case "new-vhold":
      return DecodeNewVHold(val);
    case "remove-book":
      return DecodeRemoveBook(val);
    case "try-hold":
      return DecodeTryHold(val);
    default: throw new Error(`unexpected value: ${val}`);
  }
}

export function DecodeLibraryEvents(val: any): LibraryEvents {
  return decodeLibraryEvents(val) as LibraryEvents;
}

type StorageValue = {value: unknown} | {err: Error};
type StorageDone = {value: true} | {err: Error};

type QueryQuestion = {
  store?: Record<string, true>,
  query?: Record<string, true>,
};

type QueryAnswer = {
  store: Record<string, StorageValue>,
  query: Record<string, [unknown, boolean]>,
};

type QueryGenerator<T> = Generator<QueryQuestion, T, QueryAnswer>;

function *queryGet<T>(key: string): QueryGenerator<T> {
  const ans = yield {'store': {[key]: true}};
  const sv = ans.store[key];
  if ('err' in sv) throw sv.err;
  return sv.value as T
};

type ProjectorQuestion = {
  old?: Record<string, true>,
  get?: Record<string, true>,
  set?: Record<string, unknown>,
  del?: Record<string, true>,
};

type ProjectorAnswer = {
  old: Record<string, StorageValue>,
  get: Record<string, StorageValue>,
  set: Record<string, StorageDone>,
  del: Record<string, StorageDone>,
};

type ProjectorGenerator<T> = Generator<ProjectorQuestion, T, ProjectorAnswer>;

function *projectorOld<T>(key: string): ProjectorGenerator<T> {
  const ans = yield {'old': {[key]: true}};
  const sv = ans.old[key];
  if ('err' in sv) throw sv.err;
  return sv.value as T
};

function *projectorGet<T>(key: string): ProjectorGenerator<T> {
  const ans = yield {'get': {[key]: true}};
  const sv = ans.get[key];
  if ('err' in sv) throw sv.err;
  return sv.value as T
};

function *projectorSet<T>(key: string, value: T): ProjectorGenerator<void> {
  const ans = yield {'set': {[key]: value}};
  const sv = ans.set[key];
  if ('err' in sv) throw sv.err;
};
function *projectorDel(key: string): ProjectorGenerator<void> {
  const ans = yield {'del': {[key]: true}};
  const sv = ans.del[key];
  if ('err' in sv) throw sv.err;
};

export const BookStoreQueryContext = {
  get: {
    book: (book_uuid: string) => queryGet<Book>(`book.${book_uuid}`),
    edition: (edition_isbn: string) => queryGet<Edition>(`edition.${edition_isbn}`),
    editions: () => queryGet<Set>(`editions`),
  },
};

export const BookStoreProjectorContext = {
  old: {
    book: (book_uuid: string) => projectorOld<Book>(`book.${book_uuid}`),
    edition: (edition_isbn: string) => projectorOld<Edition>(`edition.${edition_isbn}`),
    editions: () => projectorOld<Set>(`editions`),
  },
  get: {
    book: (book_uuid: string) => projectorGet<Book>(`book.${book_uuid}`),
    edition: (edition_isbn: string) => projectorGet<Edition>(`edition.${edition_isbn}`),
    editions: () => projectorGet<Set>(`editions`),
  },
  set: {
    book: (book_uuid: string, value: Book) => projectorSet(`book.${book_uuid}`, value),
    edition: (edition_isbn: string, value: Edition) => projectorSet(`edition.${edition_isbn}`, value),
    editions: (value: Set) => projectorSet(`editions`, value),
  },
  del: {
    book: (book_uuid: string) => projectorDel(`book.${book_uuid}`),
    edition: (edition_isbn: string) => projectorDel(`edition.${edition_isbn}`),
  },
};

export const PatronStoreQueryContext = {
  get: {
    patron: (patron_uuid: string) => queryGet<Patron>(`patron.${patron_uuid}`),
    patrons: () => queryGet<Set>(`patrons`),
  },
};

export const PatronStoreProjectorContext = {
  old: {
    patron: (patron_uuid: string) => projectorOld<Patron>(`patron.${patron_uuid}`),
    patrons: () => projectorOld<Set>(`patrons`),
  },
  get: {
    patron: (patron_uuid: string) => projectorGet<Patron>(`patron.${patron_uuid}`),
    patrons: () => projectorGet<Set>(`patrons`),
  },
  set: {
    patron: (patron_uuid: string, value: Patron) => projectorSet(`patron.${patron_uuid}`, value),
    patrons: (value: Set) => projectorSet(`patrons`, value),
  },
  del: {
    patron: (patron_uuid: string) => projectorDel(`patron.${patron_uuid}`),
  },
};

export const StatusStoreQueryContext = {
  get: {
    active_checkouts: () => queryGet<Set>(`active_checkouts`),
    active_holds: () => queryGet<Set>(`active_holds`),
    checkout: (checkout_uuid: string) => queryGet<Checkout>(`checkout.${checkout_uuid}`),
    hold: (hold_uuid: string) => queryGet<Hold>(`hold.${hold_uuid}`),
  },
};

export const StatusStoreProjectorContext = {
  old: {
    active_checkouts: () => projectorOld<Set>(`active_checkouts`),
    active_holds: () => projectorOld<Set>(`active_holds`),
    checkout: (checkout_uuid: string) => projectorOld<Checkout>(`checkout.${checkout_uuid}`),
    hold: (hold_uuid: string) => projectorOld<Hold>(`hold.${hold_uuid}`),
  },
  get: {
    active_checkouts: () => projectorGet<Set>(`active_checkouts`),
    active_holds: () => projectorGet<Set>(`active_holds`),
    checkout: (checkout_uuid: string) => projectorGet<Checkout>(`checkout.${checkout_uuid}`),
    hold: (hold_uuid: string) => projectorGet<Hold>(`hold.${hold_uuid}`),
  },
  set: {
    active_checkouts: (value: Set) => projectorSet(`active_checkouts`, value),
    active_holds: (value: Set) => projectorSet(`active_holds`, value),
    checkout: (checkout_uuid: string, value: Checkout) => projectorSet(`checkout.${checkout_uuid}`, value),
    hold: (hold_uuid: string, value: Hold) => projectorSet(`hold.${hold_uuid}`, value),
  },
  del: {
    checkout: (checkout_uuid: string) => projectorDel(`checkout.${checkout_uuid}`),
    hold: (hold_uuid: string) => projectorDel(`hold.${hold_uuid}`),
  },
};

export const VStatusStoreQueryContext = {
  get: {
    checkout: (checkout_uuid: string) => queryGet<VCheckout>(`checkout.${checkout_uuid}`),
    hold: (hold_uuid: string) => queryGet<VHold>(`hold.${hold_uuid}`),
    your_checkouts: () => queryGet<Set>(`your_checkouts`),
    your_holds: () => queryGet<Set>(`your_holds`),
  },
};

export const VStatusStoreProjectorContext = {
  old: {
    checkout: (checkout_uuid: string) => projectorOld<VCheckout>(`checkout.${checkout_uuid}`),
    hold: (hold_uuid: string) => projectorOld<VHold>(`hold.${hold_uuid}`),
    your_checkouts: () => projectorOld<Set>(`your_checkouts`),
    your_holds: () => projectorOld<Set>(`your_holds`),
  },
  get: {
    checkout: (checkout_uuid: string) => projectorGet<VCheckout>(`checkout.${checkout_uuid}`),
    hold: (hold_uuid: string) => projectorGet<VHold>(`hold.${hold_uuid}`),
    your_checkouts: () => projectorGet<Set>(`your_checkouts`),
    your_holds: () => projectorGet<Set>(`your_holds`),
  },
  set: {
    checkout: (checkout_uuid: string, value: VCheckout) => projectorSet(`checkout.${checkout_uuid}`, value),
    hold: (hold_uuid: string, value: VHold) => projectorSet(`hold.${hold_uuid}`, value),
    your_checkouts: (value: Set) => projectorSet(`your_checkouts`, value),
    your_holds: (value: Set) => projectorSet(`your_holds`, value),
  },
  del: {
    checkout: (checkout_uuid: string) => projectorDel(`checkout.${checkout_uuid}`),
    hold: (hold_uuid: string) => projectorDel(`hold.${hold_uuid}`),
  },
};

export const DeciderStoreQueryContext = {
  get: {
    decider_events: () => queryGet<DeciderEvents[]>(`decider_events`),
    ...BookStoreQueryContext.get,
    ...PatronStoreQueryContext.get,
    ...StatusStoreQueryContext.get,
  },
};

export const DeciderStoreProjectorContext = {
  old: {
    decider_events: () => projectorOld<DeciderEvents[]>(`decider_events`),
    ...BookStoreProjectorContext.old,
    ...PatronStoreProjectorContext.old,
    ...StatusStoreProjectorContext.old,
  },
  get: {
    decider_events: () => projectorGet<DeciderEvents[]>(`decider_events`),
    ...BookStoreProjectorContext.get,
    ...PatronStoreProjectorContext.get,
    ...StatusStoreProjectorContext.get,
  },
  set: {
    decider_events: (value: DeciderEvents[]) => projectorSet(`decider_events`, value),
    ...BookStoreProjectorContext.set,
    ...PatronStoreProjectorContext.set,
    ...StatusStoreProjectorContext.set,
  },
  del: {
    ...BookStoreProjectorContext.del,
    ...PatronStoreProjectorContext.del,
    ...StatusStoreProjectorContext.del,
  },
};

export const UserStoreQueryContext = {
  get: {
    ...BookStoreQueryContext.get,
    ...PatronStoreQueryContext.get,
    ...VStatusStoreQueryContext.get,
  },
};

export const UserStoreProjectorContext = {
  old: {
    ...BookStoreProjectorContext.old,
    ...PatronStoreProjectorContext.old,
    ...VStatusStoreProjectorContext.old,
  },
  get: {
    ...BookStoreProjectorContext.get,
    ...PatronStoreProjectorContext.get,
    ...VStatusStoreProjectorContext.get,
  },
  set: {
    ...BookStoreProjectorContext.set,
    ...PatronStoreProjectorContext.set,
    ...VStatusStoreProjectorContext.set,
  },
  del: {
    ...BookStoreProjectorContext.del,
    ...PatronStoreProjectorContext.del,
    ...VStatusStoreProjectorContext.del,
  },
};

