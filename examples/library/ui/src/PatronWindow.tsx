import { EditOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Flex, Input, List, Space, Spin, Switch, Tag, Typography } from 'antd';
import { useCallback, useRef, useState } from 'react';

import { colorHash } from './colorhash';
import { QueryGenerator, UserEngine, UserQX, VHold } from './model';
import { useLocalQuery } from './useLocalQuery';
import { usePhaseLock } from './usePhaseLock';
import { generateUuid } from './util';

const { Text } = Typography;

function PatronName({ name, onRename }: { name: string; onRename: (newName: string) => void }) {
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
        <Button size="small" type="primary" onClick={confirm}>
          OK
        </Button>
        <Button size="small" onClick={cancel}>
          Cancel
        </Button>
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
  availableRestricted: string[];
  hold: VHold | null;
};

type PatronInfo = {
  name: string;
  researcher: boolean;
};

function BookItem({
  book,
  researcher,
  onHold,
  onHoldRestricted,
  onCancelHold,
}: {
  book: BookInfo;
  researcher: boolean;
  onHold: (isbn: string) => void;
  onHoldRestricted: (isbn: string) => void;
  onCancelHold: (holdId: string) => void;
}) {
  const heldNormal = book.hold && 'edition' in book.hold.target;
  // this assumes book-targeting holds are only used for restricted books, but whatever
  const heldRestricted = book.hold && 'book' in book.hold.target;
  return (
    <List.Item>
      <div style={{ width: '100%' }}>
        <div>{book.title}</div>
        <Flex gap="small" style={{ marginTop: 4 }}>
          {/* hold or cancel-hold */}
          {heldNormal ? (
            <Button
              size="small"
              loading={book.hold!.forecasted}
              onClick={() => onCancelHold(book.hold!.id)}
              color={'green'}
              variant={'solid'}>
              Cancel Hold
            </Button>
          ) : (
            <Button
              size="small"
              disabled={heldRestricted || book.availableNormal < 1}
              onClick={() => onHold(book.isbn)}
              color={'default'}
              variant={'outlined'}>
              Hold
            </Button>
          )}
          {/* hold-restricted or cancel-hold-restricted */}
          {heldRestricted ? (
            <Button
              size="small"
              loading={book.hold!.forecasted}
              onClick={() => onCancelHold(book.hold!.id)}
              color={'green'}
              variant={'solid'}>
              Cancel Hold
            </Button>
          ) : (
            <Button
              size="small"
              disabled={heldNormal || !researcher || book.availableRestricted.length === 0}
              onClick={() => onHoldRestricted(book.availableRestricted[0])}
              color={'default'}
              variant={'outlined'}>
              Hold Restricted
            </Button>
          )}
        </Flex>
      </div>
    </List.Item>
  );
}

function Books({
  eng,
  patronId,
  researcher,
  onHold,
  onHoldRestricted,
  onCancelHold,
}: {
  eng: UserEngine;
  patronId: string;
  researcher: boolean;
  onHold: (isbn: string) => void;
  onHoldRestricted: (bookId: string) => void;
  onCancelHold: (holdId: string) => void;
}) {
  const booksLookup = useCallback(
    function* (qx: UserQX): QueryGenerator<BookInfo[]> {
      const patron = yield* qx.get.patron(patronId);
      // build maps of this patron's holds by target
      const holdsByEdition: Record<string, VHold> = {};
      const holdsByBook: Record<string, VHold> = {};
      for (const holdId of Object.keys(patron.holds)) {
        const hold = yield* qx.get.hold(holdId);
        if ('edition' in hold.target) {
          holdsByEdition[hold.target.edition] = hold;
        } else {
          holdsByBook[hold.target.book] = hold;
        }
      }
      const editions = yield* qx.get.editions();
      const out: BookInfo[] = [];
      for (const isbn of Object.keys(editions)) {
        const edition = yield* qx.get.edition(isbn);
        let availableNormal = 0;
        const restrictedBooks: { id: string; timestamp: Date }[] = [];
        for (const bookId of Object.keys(edition.books)) {
          const book = yield* qx.get.book(bookId);
          if (book.status) continue; // held or checked out
          if (book.restricted) {
            restrictedBooks.push({ id: book.id, timestamp: book.timestamp });
          } else {
            availableNormal++;
          }
        }
        restrictedBooks.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
        const availableRestricted = restrictedBooks.map((b) => b.id);
        // edition-level holds consume normal copies
        availableNormal -= Object.keys(edition.holds).length;
        // check if patron holds this edition or any book in it
        let hold = holdsByEdition[isbn];
        for (const bookId of Object.keys(edition.books)) {
          if (holdsByBook[bookId]) {
            hold = holdsByBook[bookId];
            break;
          }
        }
        out.push({ isbn, title: edition.title, availableNormal, availableRestricted, hold });
      }
      out.sort((a, b) => a.title.localeCompare(b.title));
      return out;
    },
    [patronId],
  );

  const books = useLocalQuery(eng, booksLookup);
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
          onCancelHold={onCancelHold}
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
  const [eng, connState] = usePhaseLock(relayUrl, enabled, patronId);

  const patronLookup = useCallback(
    function* (qx: UserQX): QueryGenerator<PatronInfo> {
      const patron = yield* qx.get.patron(patronId);
      return { name: patron.name, researcher: patron.researcher };
    },
    [patronId],
  );
  const patron = useLocalQuery(eng, patronLookup);

  const messagesLookup = useCallback(function* (qx: UserQX): QueryGenerator<string[]> {
    return yield* qx.get.messages();
  }, []);

  // start out dismissing any messages from an older session
  const staleMessages = useRef<number | undefined>(undefined);
  let messages = useLocalQuery(eng, messagesLookup);
  if (messages === undefined) {
    messages = [];
  } else {
    if (staleMessages.current === undefined) {
      staleMessages.current = messages.length;
    }
    messages = messages.slice(staleMessages.current);
  }
  // then dismiss additional messages from this session
  const [dismissedCount, setDismissedCount] = useState(0);
  const visibleMessages = messages.slice(dismissedCount) ?? [];

  const stateColor = {
    connecting: 'orange',
    connected: 'green',
    disconnected: 'red',
  }[connState];

  return (
    <Card
      title={
        <Flex align="center" gap="small">
          {patron ? (
            <span
              style={{
                backgroundColor: colorHash(patronId),
                padding: '2px 8px',
                borderRadius: 4,
              }}>
              <PatronName
                name={patron.name}
                onRename={(newName) =>
                  eng.sendCommands([
                    { type: 'rename-patron', id: patronId, name: newName, timestamp: new Date() },
                  ])
                }
              />
            </span>
          ) : (
            <Spin size="small" />
          )}
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
      style={{ width: '32em' }}>
      <Books
        eng={eng}
        patronId={patronId}
        researcher={patron?.researcher ?? false}
        onHold={(isbn) =>
          eng.sendCommands([
            {
              type: 'try-hold',
              id: generateUuid(),
              patron: patronId,
              target: { edition: isbn },
              open: false,
              timestamp: new Date(),
            },
          ])
        }
        onHoldRestricted={(bookId) =>
          eng.sendCommands([
            {
              type: 'try-hold',
              id: generateUuid(),
              patron: patronId,
              target: { book: bookId },
              open: false,
              timestamp: new Date(),
            },
          ])
        }
        onCancelHold={(holdId) => {
          eng.sendCommands([{ type: 'cancel-hold', id: holdId }]);
        }}
      />
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
