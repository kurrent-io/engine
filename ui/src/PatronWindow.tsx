import { useCallback, useState } from 'react';
import { Button, Card, Flex, Input, List, Switch, Spin, Tag, Typography } from 'antd';
import { EditOutlined } from '@ant-design/icons';

import {
  UserQX,
  QueryGenerator,
} from './model';
import { useQuery } from './useQuery';
import { useFramework } from './useFramework';
import { FW } from './types';

const { Text } = Typography;

function PatronName({
  name,
  onRename,
}: {
  name: string;
  onRename: (newName: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);

  function startEditing() {
    setDraft(name);
    setEditing(true);
  }

  function confirm() {
    if (draft && draft !== name) {
      onRename(draft);
    }
    setEditing(false);
  }

  function cancel() {
    setEditing(false);
  }

  if (editing) {
    return (
      <Flex gap="small" align="center">
        <Input
          size="small"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPressEnter={confirm}
          autoFocus
        />
        <Button size="small" type="primary" onClick={confirm}>OK</Button>
        <Button size="small" onClick={cancel}>Cancel</Button>
      </Flex>
    );
  }

  return (
    <Flex gap="small" align="center">
      <Text strong>{name}</Text>
      <EditOutlined onClick={startEditing} style={{ cursor: 'pointer' }} />
    </Flex>
  );
}

type BookInfo = {
  isbn: string;
  title: string;
  availableNormal: number;
  availableRestricted: number;
};

type PatronInfo = {
  name: string;
  researcher: boolean;
};

type Account = {
  holds: string[];
  checkouts: string[];
};

function BookItem({
  book,
  researcher,
  onHold,
  onHoldRestricted,
}: {
  book: BookInfo;
  researcher: boolean;
  onHold: (isbn: string) => void;
  onHoldRestricted: (isbn: string) => void;
}) {
  return (
    <List.Item>
      <div style={{ width: '100%' }}>
        <div>{book.title}</div>
        <Flex gap="small" style={{ marginTop: 4 }}>
          <Button
            size="small"
            disabled={book.availableNormal <= 0}
            onClick={() => onHold(book.isbn)}
          >
            Hold
          </Button>
          <Button
            size="small"
            disabled={!researcher || book.availableRestricted <= 0}
            onClick={() => onHoldRestricted(book.isbn)}
          >
            Hold Restricted
          </Button>
        </Flex>
      </div>
    </List.Item>
  );
}

function Books({
  fw,
  researcher,
  onHold,
  onHoldRestricted,
}: {
  fw: FW;
  researcher: boolean;
  onHold: (isbn: string) => void;
  onHoldRestricted: (isbn: string) => void;
}) {
  const booksLookup = useCallback(function*(qx: UserQX): QueryGenerator<BookInfo[]> {
    const editions = (yield* qx.get.editions()) ?? {};
    const out: BookInfo[] = [];
    for (const isbn of Object.keys(editions)) {
      const edition = yield* qx.get.edition(isbn);
      let availableNormal = 0;
      let availableRestricted = 0;
      for (const bookId of Object.keys(edition.books)) {
        const book = yield* qx.get.book(bookId);
        if (book.status) continue; // held or checked out
        if (book.restricted) {
          availableRestricted++;
        } else {
          availableNormal++;
        }
      }
      // edition-level holds consume normal copies
      availableNormal -= Object.keys(edition.holds).length;
      out.push({ isbn, title: edition.title, availableNormal, availableRestricted });
    }
    return out;
  }, []);

  const books = useQuery(fw, booksLookup);
  if (!books) return <Spin />;

  return (
    <List
      dataSource={books}
      renderItem={(book) => (
        <BookItem
          book={book}
          researcher={researcher}
          onHold={onHold}
          onHoldRestricted={onHoldRestricted}
        />
      )}
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
    return { holds, checkouts };
  }, [patronId]);

  const account = useQuery(fw, myAccountLookup);
  if (!account) return <Spin />;

  return (<>
    <h3>Holds:</h3>
    <List dataSource={account.holds} renderItem={(item) => <List.Item>{item}</List.Item>} />
    <h3>Checkouts:</h3>
    <List dataSource={account.checkouts} renderItem={(item) => <List.Item>{item}</List.Item>} />
  </>);
}

export default function PatronWindow({
  patronId,
  relayUrl,
}: {
  patronId: string;
  relayUrl: string;
}) {
  const [enabled, setEnabled] = useState(true);
  const [fw, connState] = useFramework(relayUrl, patronId, enabled);

  const patronLookup = useCallback(function*(qx: UserQX): QueryGenerator<PatronInfo> {
    const patron = yield* qx.get.patron(patronId);
    return { name: patron.name, researcher: patron.researcher };
  }, [patronId]);
  const patron = useQuery(fw, patronLookup);

  const stateColor = {
    connecting: 'orange',
    connected: 'green',
    disconnected: 'red',
  }[connState];

  return (
    <Card
      title={
        <Flex align="center" gap="small">
          {patron
            ? <PatronName name={patron.name} onRename={(_newName) => { /* TODO: wire sendCommands */ }} />
            : <Spin size="small" />
          }
          {patron?.researcher && <Tag color="green">researcher</Tag>}
          <span style={{ flex: 1 }} />
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
          <Books
            fw={fw}
            researcher={patron?.researcher ?? false}
            onHold={(_isbn) => { /* TODO: wire sendCommands */ }}
            onHoldRestricted={(_isbn) => { /* TODO: wire sendCommands */ }}
          />
        </div>
      </Card>
      <Card type="inner" title="My Account">
        <MyAccount fw={fw} patronId={patronId} />
      </Card>
    </Card>
  );
}
