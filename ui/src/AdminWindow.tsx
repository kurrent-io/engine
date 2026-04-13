import { useCallback, useState } from 'react';
import { Button, Card, Divider, Flex, Input, List, Modal, Spin, Switch, Tag, Typography } from 'antd';
import { EditOutlined, PlusOutlined } from '@ant-design/icons';

import { AdminQX, QueryGenerator } from './model';
import { useQuery } from './useQuery';
import { useFramework } from './useFramework';
import { generateUuid } from './util';
import { colorHash } from './colorhash';

const { Text } = Typography;

/* ---- types ---- */

type AdminBookInfo = {
  id: string;
  restricted: boolean;
  state: 'open' | 'rstr' | 'held' | 'out';
  patronId?: string;
  holdId?: string;
  checkoutId?: string;
};

type AdminEditionInfo = {
  isbn: string;
  title: string;
  books: AdminBookInfo[];
};

type AdminPatronInfo = {
  id: string;
  name: string;
  researcher: boolean;
};

type PendingAction =
  | { type: 'book'; bookId: string; restricted: boolean }
  | { type: 'held'; bookId: string; restricted: boolean; holdId: string; patronId: string }
  | null;

/* ---- inline edit ---- */

function InlineEdit({
  value,
  onConfirm,
}: {
  value: string;
  onConfirm: (newValue: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  function startEditing() {
    setDraft(value);
    setEditing(true);
  }

  function confirm() {
    if (draft && draft !== value) {
      onConfirm(draft);
    }
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
        <Button size="small" onClick={() => setEditing(false)}>Cancel</Button>
      </Flex>
    );
  }

  return (
    <Flex gap="small" align="center">
      <Text strong>{value}</Text>
      <EditOutlined onClick={startEditing} style={{ cursor: 'pointer' }} />
    </Flex>
  );
}

/* ---- main component ---- */

export default function AdminWindow({ relayUrl }: { relayUrl: string }) {
  const [enabled, setEnabled] = useState(true);
  const [fw, connState] = useFramework(relayUrl, enabled);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [addingEdition, setAddingEdition] = useState(false);
  const [newEditionTitle, setNewEditionTitle] = useState('');

  // --- queries ---

  const patronsLookup = useCallback(function*(qx: AdminQX): QueryGenerator<AdminPatronInfo[]> {
    const patrons = yield* qx.get.patrons();
    const out: AdminPatronInfo[] = [];
    for (const id of Object.keys(patrons).sort()) {
      const patron = yield* qx.get.patron(id);
      out.push({ id, name: patron.name, researcher: patron.researcher });
    }
    return out;
  }, []);

  const editionsLookup = useCallback(function*(qx: AdminQX): QueryGenerator<AdminEditionInfo[]> {
    const editions = yield* qx.get.editions();
    const out: AdminEditionInfo[] = [];
    for (const isbn of Object.keys(editions)) {
      const edition = yield* qx.get.edition(isbn);
      // fetch all books and sort by timestamp (insertion order)
      const allBooks = [];
      for (const bookId of Object.keys(edition.books)) {
        allBooks.push(yield* qx.get.book(bookId));
      }
      allBooks.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      const books: AdminBookInfo[] = [];

      // edition-level holds: visually assign to first N unrestricted available books
      const editionHoldIds = Object.keys(edition.holds);
      let editionHoldIdx = 0;

      for (const book of allBooks) {
        const bookId = book.id;

        if (book.status) {
          if ("hold" in book.status) {
            const hold = yield* qx.get.hold(book.status.hold);
            books.push({
              id: bookId, restricted: book.restricted, state: 'held',
              patronId: hold.patron, holdId: hold.id,
            });
          } else {
            const checkout = yield* qx.get.checkout(book.status.checkout);
            books.push({
              id: bookId, restricted: book.restricted, state: 'out',
              patronId: checkout.patron, checkoutId: checkout.id,
            });
          }
        } else if (!book.restricted && editionHoldIdx < editionHoldIds.length) {
          const holdId = editionHoldIds[editionHoldIdx++];
          const hold = yield* qx.get.hold(holdId);
          books.push({
            id: bookId, restricted: book.restricted, state: 'held',
            patronId: hold.patron, holdId: hold.id,
          });
        } else {
          books.push({
            id: bookId, restricted: book.restricted,
            state: book.restricted ? 'rstr' : 'open',
          });
        }
      }

      out.push({ isbn, title: edition.title, books });
    }
    out.sort((a, b) => a.title.localeCompare(b.title));
    return out;
  }, []);

  const patrons = useQuery(fw, patronsLookup);
  const editions = useQuery(fw, editionsLookup);

  // --- handlers ---

  function handleBookClick(book: AdminBookInfo) {
    switch (book.state) {
      case 'open':
      case 'rstr':
        setPendingAction({ type: 'book', bookId: book.id, restricted: book.restricted });
        break;
      case 'held':
        setPendingAction({
          type: 'held', bookId: book.id, restricted: book.restricted,
          holdId: book.holdId!, patronId: book.patronId!,
        });
        break;
      case 'out':
        fw.sendCommands([{
          type: "end-checkout", checkout: book.checkoutId!, timestamp: new Date(),
        }]);
        break;
    }
  }

  function handleCheckout(patronId: string) {
    if (pendingAction?.type !== 'book') return;
    fw.sendCommands([{
      type: "try-checkout",
      id: generateUuid(),
      patron: patronId,
      book: pendingAction.bookId,
      timestamp: new Date(),
    }]);
    setPendingAction(null);
  }

  function handleToggleRestricted() {
    if (!pendingAction) return;
    fw.sendCommands([{
      type: "update-book-restricted",
      id: pendingAction.bookId,
      restricted: !pendingAction.restricted,
      timestamp: new Date(),
    }]);
    setPendingAction(null);
  }

  function handleCancelHold() {
    if (pendingAction?.type !== 'held') return;
    fw.sendCommands([{ type: "cancel-hold", id: pendingAction.holdId }]);
    setPendingAction(null);
  }

  function handlePromoteHold() {
    if (pendingAction?.type !== 'held') return;
    fw.sendCommands([{
      type: "try-checkout",
      id: generateUuid(),
      patron: pendingAction.patronId,
      book: pendingAction.bookId,
      timestamp: new Date(),
    }]);
    setPendingAction(null);
  }

  // --- render ---

  const stateColor = {
    connecting: 'orange',
    connected: 'green',
    disconnected: 'red',
  }[connState];

  return (
    <Card
      title={
        <Flex align="center" gap="small">
          <Text strong>Admin</Text>
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
      {/* patrons */}
      <Text strong>Patrons</Text>
      {patrons ? (
        <List
          size="small"
          dataSource={patrons}
          renderItem={(patron) => (
            <List.Item>
              <Flex gap="small" align="center" style={{ width: '100%' }}>
                <span style={{
                  backgroundColor: `${colorHash(patron.id)}`,
                  padding: '2px 8px',
                  borderRadius: 4,
                }}>
                  <InlineEdit
                    value={patron.name}
                    onConfirm={(name) => fw.sendCommands([{
                      type: "rename-patron", id: patron.id, name, timestamp: new Date(),
                    }])}
                  />
                </span>
                <span style={{ flex: 1 }} />
                <Switch
                  size="small"
                  checked={patron.researcher}
                  onChange={(checked) => fw.sendCommands([{
                    type: "assign-patron", id: patron.id,
                    researcher: checked, timestamp: new Date(),
                  }])}
                  checkedChildren="R"
                  unCheckedChildren="R"
                />
              </Flex>
            </List.Item>
          )}
        />
      ) : <Spin />}

      {/* editions & books */}
      <Flex align="center" gap="small" style={{ marginTop: 16 }}>
        <Text strong>Editions</Text>
        <PlusOutlined
          style={{ cursor: 'pointer' }}
          onClick={() => { setNewEditionTitle(''); setAddingEdition(true); }}
        />
      </Flex>
      {editions ? (
        <List
          size="small"
          dataSource={editions}
          renderItem={(edition) => (
            <List.Item>
              <div style={{ width: '100%' }}>
                <InlineEdit
                  value={edition.title}
                  onConfirm={(title) => fw.sendCommands([{
                    type: "update-edition-title", isbn: edition.isbn,
                    title, timestamp: new Date(),
                  }])}
                />
                <Flex gap="small" style={{ marginTop: 4 }} wrap>
                  {edition.books.map((book) => {
                    const color = book.patronId
                      ? `${colorHash(book.patronId)}`
                      : undefined;
                    return (
                      <Button
                        key={book.id}
                        size="small"
                        onClick={() => handleBookClick(book)}
                        style={color ? { borderColor: color, borderWidth: 2 } : undefined}
                      >
                        {book.state}
                      </Button>
                    );
                  })}
                  <Button
                    size="small"
                    type="text"
                    icon={<PlusOutlined />}
                    onClick={() => fw.sendCommands([{
                      type: "add-book",
                      id: generateUuid(),
                      isbn: edition.isbn,
                      restricted: false,
                      timestamp: new Date(),
                    }])}
                  />
                </Flex>
              </div>
            </List.Item>
          )}
        />
      ) : <Spin />}

      {/* modal: available book actions */}
      <Modal
        title="Book actions"
        open={pendingAction?.type === 'book'}
        onCancel={() => setPendingAction(null)}
        footer={null}
      >
        <Text strong>Check out to:</Text>
        <Flex gap="small" wrap style={{ marginTop: 8 }}>
          {patrons?.map((patron) => {
            const restricted = pendingAction?.type === 'book' && pendingAction.restricted;
            const disabled = restricted && !patron.researcher;
            return (
              <Button
                key={patron.id}
                disabled={disabled}
                onClick={() => handleCheckout(patron.id)}
                style={disabled ? undefined : { borderColor: `${colorHash(patron.id)}`, borderWidth: 2 }}
              >
                {patron.name}
              </Button>
            );
          })}
        </Flex>
        <Divider />
        <Button onClick={handleToggleRestricted}>
          {pendingAction?.type === 'book' && pendingAction.restricted
            ? 'Mark Unrestricted'
            : 'Mark Restricted'}
        </Button>
      </Modal>

      {/* modal: held book actions */}
      <Modal
        title="Held book"
        open={pendingAction?.type === 'held'}
        onCancel={() => setPendingAction(null)}
        footer={null}
      >
        <Flex gap="small">
          <Button onClick={handleCancelHold}>Cancel Hold</Button>
          <Button type="primary" onClick={handlePromoteHold}>Check Out</Button>
        </Flex>
        <Divider />
        <Button onClick={handleToggleRestricted}>
          {pendingAction?.type === 'held' && pendingAction.restricted
            ? 'Mark Unrestricted'
            : 'Mark Restricted'}
        </Button>
      </Modal>

      {/* modal: add edition */}
      <Modal
        title="New edition"
        open={addingEdition}
        onCancel={() => setAddingEdition(false)}
        onOk={() => {
          if (newEditionTitle.trim()) {
            fw.sendCommands([{
              type: "add-edition",
              isbn: generateUuid(),
              title: newEditionTitle.trim(),
              timestamp: new Date(),
            }]);
          }
          setAddingEdition(false);
        }}
      >
        <Input
          placeholder="Title"
          value={newEditionTitle}
          onChange={(e) => setNewEditionTitle(e.target.value)}
          onPressEnter={() => {
            if (newEditionTitle.trim()) {
              fw.sendCommands([{
                type: "add-edition",
                isbn: generateUuid(),
                title: newEditionTitle.trim(),
                timestamp: new Date(),
              }]);
            }
            setAddingEdition(false);
          }}
          autoFocus
        />
      </Modal>
    </Card>
  );
}
