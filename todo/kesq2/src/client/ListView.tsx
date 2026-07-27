import { useMemo, useState } from 'react';

import type { KesqClient } from './useFramework';
import { useQuery } from './useQuery';
import { listStats } from '#queries/stats';
import { generateUuid } from '../util';
import type { ItemView, ListData } from '../types';

function EditTextRow({
  initial,
  placeholder,
  onSave,
  onCancel,
}: {
  initial: string;
  placeholder?: string;
  onSave: (next: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);

  function submit() {
    const trimmed = text.trim();
    if (trimmed && trimmed !== initial) onSave(trimmed);
    onCancel();
  }

  return (
    <div className="row">
      <input
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') onCancel();
        }}
        autoFocus
      />
      <button className="primary" onClick={submit}>OK</button>
      <button onClick={onCancel}>Cancel</button>
    </div>
  );
}

function ItemRow({
  item,
  onToggle,
  onEdit,
  onArchive,
}: {
  item: ItemView;
  onToggle: () => void;
  onEdit: (text: string) => void;
  onArchive: () => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <EditTextRow
        initial={item.text}
        onSave={onEdit}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <div className="row clickable hoverable" onClick={onToggle}>
      <span className={item.done ? 'grow done' : 'grow'}>{item.text}</span>
      <button
        className="hover-action"
        onClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
      >
        ✎
      </button>
      <button
        className="hover-action"
        onClick={(e) => {
          e.stopPropagation();
          onArchive();
        }}
      >
        ✕
      </button>
    </div>
  );
}

export function InlineAdd({
  label,
  placeholder,
  onSubmit,
}: {
  label: string;
  placeholder: string;
  onSubmit: (text: string) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <EditTextRow
        initial=""
        placeholder={placeholder}
        onSave={onSubmit}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <div className="row clickable dim" onClick={() => setEditing(true)}>
      + {label}
    </div>
  );
}

export default function ListView({ client, list }: { client: KesqClient; list: ListData }) {
  const [renaming, setRenaming] = useState(false);

  // the same flexible module as boardStats, but this call site pins the
  // query local — it runs against the browser's synced state
  const stats = useQuery(client, useMemo(() => listStats(list.id), [list.id]), 'local');

  const send = client.sendCommands;

  return (
    <section className="list">
      <div className="list-title">
        {renaming ? (
          <EditTextRow
            initial={list.name}
            onSave={(name) => send([{ type: 'rename-list', id: list.id, name }])}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <div className="row hoverable">
            <strong className="grow">{list.name}</strong>
            {stats && (
              <span className="badge">
                {stats.done}/{stats.total} done @local
              </span>
            )}
            <button className="hover-action" onClick={() => setRenaming(true)}>✎</button>
            <button
              className="hover-action"
              onClick={() => send([{ type: 'archive-list', id: list.id }])}
            >
              ✕
            </button>
          </div>
        )}
      </div>
      {list.items.map((item) => (
        <ItemRow
          key={item.id}
          item={item}
          onToggle={() => send([{ type: 'mark-item', id: item.id, done: !item.done }])}
          onEdit={(text) => send([{ type: 'edit-item', id: item.id, text }])}
          onArchive={() => send([{ type: 'archive-item', id: item.id }])}
        />
      ))}
      <InlineAdd
        label="add item"
        placeholder="item text"
        onSubmit={(text) =>
          send([{ type: 'new-item', id: generateUuid(), list: list.id, text }])
        }
      />
    </section>
  );
}
