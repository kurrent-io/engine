import { CloseOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Flex, Input, Typography } from 'antd';
import { useState } from 'react';

const { Text } = Typography;

export type ItemView = {
  id: string;
  text: string;
  done: boolean;
};

export type ListData = {
  id: string;
  name: string;
  items: ItemView[];
};

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
    <Flex className="row" gap="small" align="center">
      <Input
        size="small"
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPressEnter={submit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
        autoFocus
      />
      <Button size="small" type="primary" onClick={submit}>
        OK
      </Button>
      <Button size="small" onClick={onCancel}>
        Cancel
      </Button>
    </Flex>
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
    return <EditTextRow initial={item.text} onSave={onEdit} onCancel={() => setEditing(false)} />;
  }

  return (
    <Flex className="row clickable hoverable" align="center" gap="small" onClick={onToggle}>
      <span className={item.done ? 'grow done' : 'grow'}>{item.text}</span>
      <Button
        className="hover-action"
        size="small"
        type="text"
        icon={<EditOutlined />}
        onClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
      />
      <Button
        className="hover-action"
        size="small"
        type="text"
        icon={<CloseOutlined />}
        onClick={(e) => {
          e.stopPropagation();
          onArchive();
        }}
      />
    </Flex>
  );
}

function InlineAdd({
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
    <Flex className="row clickable dim" align="center" gap="small" onClick={() => setEditing(true)}>
      <PlusOutlined />
      <Text type="secondary">{label}</Text>
    </Flex>
  );
}

export default function ListView({
  list,
  onRenameList,
  onArchiveList,
  onAddItem,
  onToggleItem,
  onEditItem,
  onArchiveItem,
}: {
  list: ListData;
  onRenameList: (name: string) => void;
  onArchiveList: () => void;
  onAddItem: (text: string) => void;
  onToggleItem: (itemId: string, done: boolean) => void;
  onEditItem: (itemId: string, text: string) => void;
  onArchiveItem: (itemId: string) => void;
}) {
  const [renamingList, setRenamingList] = useState(false);

  return (
    <div className="list">
      <div className="list-title">
        {renamingList ? (
          <EditTextRow
            initial={list.name}
            onSave={onRenameList}
            onCancel={() => setRenamingList(false)}
          />
        ) : (
          <Flex className="row hoverable" align="center" gap="small">
            <Text strong className="grow">
              {list.name}
            </Text>
            <Button
              className="hover-action"
              size="small"
              type="text"
              icon={<EditOutlined />}
              onClick={() => setRenamingList(true)}
            />
            <Button
              className="hover-action"
              size="small"
              type="text"
              icon={<CloseOutlined />}
              onClick={onArchiveList}
            />
          </Flex>
        )}
      </div>
      {list.items.map((item) => (
        <ItemRow
          key={item.id}
          item={item}
          onToggle={() => onToggleItem(item.id, !item.done)}
          onEdit={(text) => onEditItem(item.id, text)}
          onArchive={() => onArchiveItem(item.id)}
        />
      ))}
      <InlineAdd label="add item" placeholder="item text" onSubmit={onAddItem} />
    </div>
  );
}

export { InlineAdd };
