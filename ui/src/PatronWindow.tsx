import { useCallback, useState } from 'react';
import { Alert, Button, Card, Flex, Input, List, Space, Switch, Spin, Tag, Typography } from 'antd';
import { EditOutlined } from '@ant-design/icons';

import {
  UserFramework,
  UserQX,
  QueryGenerator,
} from './model';
import { useQuery } from './useQuery';
import { useFramework } from './useFramework';
import { generateUuid } from './util';

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

function BookItem({
  book,
  researcher,
  onHold,
}: {
  book: BookInfo;
  researcher: boolean;
  onHold: (isbn: string) => void;
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
            onClick={() => onHold(book.isbn)}
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
}: {
  fw: UserFramework;
  researcher: boolean;
  onHold: (isbn: string) => void;
}) {
  const booksLookup = useCallback(function*(qx: UserQX): QueryGenerator<BookInfo[]> {
    const editions = yield* qx.get.editions();
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
        />
      )}
    />
  );
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

  const messagesLookup = useCallback(function*(qx: UserQX): QueryGenerator<string[]> {
    return yield* qx.get.messages();
  }, []);
  const messages = useQuery(fw, messagesLookup);
  const [dismissedCount, setDismissedCount] = useState(0);
  const visibleMessages = messages?.slice(dismissedCount) ?? [];

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
            ? <PatronName name={patron.name} onRename={(newName) => fw.sendCommands([
                { type: "rename-patron", id: patronId, name: newName, timestamp: new Date() },
              ])} />
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
      <Card type="inner" title="Books">
        <div style={{ maxHeight: '20em', overflowY: 'auto' }}>
          <Books
            fw={fw}
            researcher={patron?.researcher ?? false}
            onHold={(isbn) => fw.sendCommands([{
              type: "try-hold",
              id: generateUuid(),
              patron: patronId,
              target: { edition: isbn },
              open: false,
              timestamp: new Date(),
            }])}
          />
        </div>
      </Card>
      {visibleMessages.length > 0 && (
        <div style={{ marginTop: '0.5em' }}>
          <Space direction="vertical" style={{ width: '100%' }} size="small">
            {visibleMessages.map((msg, i) => (
              <Alert key={dismissedCount + i} type="warning" showIcon message={msg} />
            ))}
            <Button size="small" onClick={() => setDismissedCount(messages?.length ?? 0)}>
              Dismiss
            </Button>
          </Space>
        </div>
      )}
    </Card>
  );
}
