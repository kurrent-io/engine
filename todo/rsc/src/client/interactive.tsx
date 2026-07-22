'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';

import { sendCommand } from './connection';
import { generateUuid } from '../util';
import type { ItemView } from '../types';

/* The interactive leaves of the tree.  These are the only components that
   ship to the browser as code; everything they know arrives as serialized
   props from the server components.  Since functions can't cross the
   server→client boundary, they don't take callbacks — they build commands
   themselves and send them up the websocket. */

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

export function ListCard({
  id,
  name,
  children,
}: {
  id: string;
  name: string;
  children: ReactNode;
}) {
  const [renaming, setRenaming] = useState(false);

  return (
    <section className="list">
      <div className="list-title">
        {renaming ? (
          <EditTextRow
            initial={name}
            onSave={(next) => sendCommand({ type: 'rename-list', id, name: next })}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <div className="row hoverable">
            <strong className="grow">{name}</strong>
            <button className="hover-action" onClick={() => setRenaming(true)}>✎</button>
            <button
              className="hover-action"
              onClick={() => sendCommand({ type: 'archive-list', id })}
            >
              ✕
            </button>
          </div>
        )}
      </div>
      {/* server-rendered item rows pass through here */}
      {children}
    </section>
  );
}

export function ItemRow({ item }: { item: ItemView }) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <EditTextRow
        initial={item.text}
        onSave={(text) => sendCommand({ type: 'edit-item', id: item.id, text })}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <div
      className="row clickable hoverable"
      onClick={() => sendCommand({ type: 'mark-item', id: item.id, done: !item.done })}
    >
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
          sendCommand({ type: 'archive-item', id: item.id });
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
  field,
  command,
}: {
  label: string;
  placeholder: string;
  // the command to send, minus its fresh uuid and the text field named by `field`
  field: string;
  command: { type: string } & Record<string, unknown>;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <EditTextRow
        initial=""
        placeholder={placeholder}
        onSave={(text) => sendCommand({ ...command, id: generateUuid(), [field]: text })}
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
