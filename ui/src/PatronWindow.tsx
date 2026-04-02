import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, Flex, List, Switch, Spin, Tag } from 'antd';

import {
  InMemStorage,
  UserFramework,
  UserQX,
  QueryGenerator,
  DecodeLibraryEvents,
  userMigrate,
  userReducer,
} from './model';
import { useQuery } from './useQuery';

type FW = UserFramework<number>;


type Book = { title: string; copies: number };

type Account = {
  name: string;
  checkouts: string[];
  holds: string[];
};

function Books({ fw }: { fw: FW }) {
  const booksLookup = useCallback(function*(qx: UserQX): QueryGenerator<Book[]> {
    const editions = (yield* qx.get.editions()) ?? {};
    const out: Book[] = [];
    for (const isbn of Object.keys(editions)) {
      const edition = yield* qx.get.edition(isbn);
      out.push({ title: edition.title, copies: Object.keys(edition.books).length });
    }
    return out;
  }, []);

  const books = useQuery(fw, booksLookup);
  if (!books) return <Spin />;

  return (
    <List
      dataSource={books}
      renderItem={(book) => <List.Item>{`${book.title} (x${book.copies})`}</List.Item>}
    />
  );
}

function MyAccount({ fw, patronId }: { fw: FW; patronId: string }) {
  const myAccountLookup = useCallback(function*(qx: UserQX): QueryGenerator<Account> {
    const patron = yield* qx.get.patron(patronId);
    const holds = [];
    for (const hold_uuid of Object.keys(patron.holds)) {
      const hold = yield* qx.get.hold(hold_uuid);
      if ("book" in hold.target) {
        const book = yield* qx.get.book(hold.target.book);
        const edition = yield* qx.get.edition(book.isbn);
        holds.push(edition.title);
      } else {
        const edition = yield* qx.get.edition(hold.target.edition);
        holds.push(edition.title);
      }
    }
    const checkouts = [];
    for (const checkout_uuid of Object.keys(patron.checkouts)) {
      const checkout = yield* qx.get.checkout(checkout_uuid);
      const book = yield* qx.get.book(checkout.book);
      const edition = yield* qx.get.edition(book.isbn);
      checkouts.push(edition.title);
    }
    return { name: patron.name, holds, checkouts };
  }, [patronId]);

  const account = useQuery(fw, myAccountLookup);
  if (!account) return <Spin />;

  return (<>
    <h3>Name: {account.name}</h3>
    <h3>Holds:</h3>
    <List dataSource={account.holds} renderItem={(item) => <List.Item>{item}</List.Item>} />
    <h3>Checkouts:</h3>
    <List dataSource={account.checkouts} renderItem={(item) => <List.Item>{item}</List.Item>} />
  </>);
}

type ConnectionState = 'connecting' | 'connected' | 'disconnected';

export default function PatronWindow({
  patronId,
  relayUrl,
}: {
  patronId: string;
  relayUrl: string;
}) {
  const [enabled, setEnabled] = useState(true);
  const [connState, setConnState] = useState<ConnectionState>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);

  const fw = useMemo(() => {
    const storage = new InMemStorage();
    return new UserFramework<number>(storage, {
      migrate: userMigrate,
      reducer: userReducer,
    });
  }, []);

  useEffect(() => {
    if (!enabled) {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setConnState('disconnected');
      return;
    }

    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function connect() {
      if (cancelled) return;

      setConnState('connecting');

      // get checkpoint from framework storage
      fw.reconnect((result) => {
        if (cancelled) return;

        const ws = new WebSocket(relayUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          if (cancelled) { ws.close(); return; }
          // send handshake
          ws.send(JSON.stringify({
            patron_id: patronId,
            since: result.checkpoint ?? null,
          }));
          setConnState('connected');
        };

        ws.onmessage = (msg) => {
          const wrapped = JSON.parse(msg.data);
          const event = DecodeLibraryEvents(wrapped.event);
          fw.recvEvents([event], wrapped.position);
        };

        ws.onclose = () => {
          if (cancelled) return;
          setConnState('disconnected');
          wsRef.current = null;
          reconnectTimer = setTimeout(connect, 2000);
        };

        ws.onerror = () => {
          // onclose will fire after onerror
        };
      });
    }

    connect();

    return () => {
      cancelled = true;
      clearTimeout(reconnectTimer);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [enabled, fw, patronId, relayUrl]);

  const stateColor = {
    connecting: 'orange',
    connected: 'green',
    disconnected: 'red',
  }[connState];

  return (
    <Card
      title={
        <Flex align="center" gap="small">
          <span>Patron: {patronId}</span>
          <Tag color={stateColor}>{connState}</Tag>
          <Switch
            size="small"
            checked={enabled}
            onChange={setEnabled}
            checkedChildren="on"
            unCheckedChildren="off"
          />
        </Flex>
      }
      style={{ width: '32em' }}
    >
      <Card type="inner" title="Books" style={{ marginBottom: '1em' }}>
        <div style={{ maxHeight: '20em', overflowY: 'auto' }}>
          <Books fw={fw} />
        </div>
      </Card>
      <Card type="inner" title="My Account">
        <MyAccount fw={fw} patronId={patronId} />
      </Card>
    </Card>
  );
}
