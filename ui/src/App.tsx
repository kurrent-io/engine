import { Button, ConfigProvider, Flex, Card, List, Spin, theme } from 'antd';
import { Suspense, useCallback, useMemo, useState, useEffect } from 'react';

import { Query, QueryFunction, QueryGenerator } from './model';
import { FW, QX, makeAddBook, makeAddCheckout, makeRetitleBook } from './index';

type Book = { title: string, copies: number };

function Books({getBooks}: {getBooks: () => Book[]}) {
  return (
  <List
    dataSource={getBooks()}
    renderItem={(book) => <List.Item>{`${book.title} (x${book.copies})`}</List.Item>}
  />
  );
}

type Account = {
  name: string,
  checkouts: string[],
  holds: string[],
};

function MyAccount({getMyAccount}: {getMyAccount: () => Account}) {
  const account = getMyAccount();
  const holds = account.holds.length == 0 ? "<empty list>" : (
    <List
      dataSource={account.holds}
      renderItem={(item) => <List.Item>{item}</List.Item>}
    />
  )
  const checkouts = account.checkouts.length == 0 ? "<empty list>" : (
    <List
      dataSource={account.checkouts}
      renderItem={(item) => <List.Item>{item}</List.Item>}
    />
  )
  return (<>
      <h3>Name: {account.name}</h3>
      <h3>Holds:</h3>
      {holds}
      <h3>Checkouts:</h3>
      {checkouts}
  </>);
}

/* Like useState() except:
    - initial value defaults to undefined
    - returns a getter for the value, which suspends if the value is undefined
    - if the setter is set back to undefined, the getter will start suspending again */
export function useSuspendedState<T>(initial?: T): [() => T, (val: T | undefined) => void] {
  const [val, setVal] = useState<T | undefined>(initial);

  const [readyPromise, setReady] = useMemo(() => {
    if (val !== undefined) return [null, setVal];
    let resolve: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return [
      promise,
      (x: T | undefined) => {
        // Unconditionally set the value.
        setVal(x);
        // Conditionally resolve the promise.
        if (x !== undefined) resolve();
      },
    ];
  }, [val]);

  const getter = useCallback(() => {
    if (val === undefined) throw readyPromise;
    return val;
  }, [readyPromise, val]);

  return [getter, setReady];
}

// returns the query itself, and a value getter that suspends if no value is set yet
function useQuery<T>(fw: FW, fn: QueryFunction<QX, T>): [Query<T>, () => T] {
  const [getState, setState] = useSuspendedState<T>(undefined);

  const query = useMemo(() => {
    const query = fw.newQuery(fn);
    query.subscribe((t: T) => {
      setState(t);
    });
    return query;
  }, [fw, fn]);

  useEffect(() => {
    return () => {
      query.close()
    };
  }, [query])

  return [query, getState];
}

function App({fw}: {fw: FW}) {
  // subscribe to list of books from our store
  const booksLookup = useCallback(function*(qx: QX): QueryGenerator<Book[]> {
    // get the set of all editions
    const editions = (yield* qx.get.editions()) ?? {};
    // for each edition, get the title and number of copies
    const out: Book[] = [];
    for (const isbn of Object.keys(editions)) {
      const edition = yield* qx.get.edition(isbn);
      out.push({title: edition.title, copies: Object.keys(edition.books).length});
    }
    return out;
  }, []);
  const [, getBooks] = useQuery(fw, booksLookup);

  const myAccountLookup = useCallback(function*(qx: QX): QueryGenerator<Account> {
    // locate the patron object
    const patron = yield* qx.get.patron("my-patron-id");
    // get the title of each hold
    const holds = [];
    for (const hold_uuid of Object.keys(patron.holds)) {
      const hold = yield* qx.get.hold(hold_uuid);
      if ("book" in hold.target) {
        // a specific book is being held; look up the book
        const book = yield* qx.get.book(hold.target.book);
        // then look up the edition of the book
        const edition = yield* qx.get.edition(book.isbn);
        holds.push(edition.title);
      } else {
        // any book of a certain edition is being held
        const edition = yield* qx.get.edition(hold.target.edition);
        holds.push(edition.title);
      }
    }
    // get the title of each checkout
    const checkouts = [];
    for (const checkout_uuid of Object.keys(patron.checkouts)) {
      const checkout = yield* qx.get.checkout(checkout_uuid);
      // look up the book
      const book = yield* qx.get.book(checkout.book);
      // then look up the edition of the book
      const edition = yield* qx.get.edition(book.isbn);
      checkouts.push(edition.title);
    }
    return { name: patron.name, holds, checkouts };
  }, []);
  const [, getMyAccount] = useQuery(fw, myAccountLookup);

  const addBook = useMemo(() => {
    // short circuit backend; send events directly into framework
    return makeAddBook(fw);
  }, [fw]);

  const addCheckout = useMemo(() => {
    // short circuit backend; send events directly into framework
    return makeAddCheckout(fw);
  }, [fw])

  const retitleBook = useMemo(() => {
    // short circuit backend; send events directly into framework
    return makeRetitleBook(fw);
  }, [fw])

  const { darkAlgorithm } = theme;

  return (
    <ConfigProvider theme={{algorithm: darkAlgorithm}}>
      <div>
        <h1>Sync Engine Frontend Demo</h1>
        <Flex wrap gap="small">
          <Card title="Controls" style={{width: "28em"}}>
            <div style={{maxHeight: "28em"}}>
              <Flex wrap gap="small">
                <Button onClick={addBook}>Add Book</Button>
                <Button onClick={addCheckout}>Add Checkout</Button>
                <Button onClick={retitleBook}>Retitle Book</Button>
              </Flex>
            </div>
          </Card>
          <Card title="Books" style={{width: "28em"}}>
            <Suspense fallback={<Spin/>}>
              <div style={{maxHeight: "28em", overflowY: "auto"}}>
                <Books getBooks={getBooks} />
              </div>
            </Suspense>
          </Card>
          <Card title="My Account" style={{width: "28em"}}>
            <Suspense fallback={<Spin/>}>
              <MyAccount getMyAccount={getMyAccount} />
            </Suspense>
          </Card>
        </Flex>
      </div>
    </ConfigProvider>
  );
};

export default App;
