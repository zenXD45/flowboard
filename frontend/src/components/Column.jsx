import { useRef, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import CardTile from './CardTile.jsx';
import Icon from './Icon.jsx';

export default function Column({ list, cards, people, canEdit, onOpenCard, onCreateCard, onRename, onDelete }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(list.title);
  const inputRef = useRef(null);

  const { setNodeRef, isOver } = useDroppable({
    id: `list:${list.id}`,
    data: { type: 'list', list }
  });

  const submitCard = async () => {
    const value = draft.trim();
    setDraft('');
    setAdding(false);
    if (value) await onCreateCard(list.id, value);
  };

  const submitTitle = () => {
    const value = title.trim();
    setRenaming(false);
    setTitle(list.title);
    if (value && value !== list.title) onRename(list.id, value);
  };

  return (
    <section className="column" aria-label={list.title}>
      <header className="column__head">
        {renaming ? (
          <input
            ref={inputRef}
            className="column__rename"
            value={title}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
            onBlur={submitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitTitle();
              if (e.key === 'Escape') {
                setTitle(list.title);
                setRenaming(false);
              }
            }}
            maxLength={60}
          />
        ) : (
          <button
            type="button"
            className="column__title"
            onClick={() => canEdit && setRenaming(true)}
            title={canEdit ? 'Rename list' : undefined}
          >
            {list.title}
          </button>
        )}
        <span className="column__count">{cards.length}</span>
        {canEdit && (
          <button
            type="button"
            className="iconbtn"
            onClick={() => onDelete(list.id)}
            title="Delete list and its cards"
            aria-label={`Delete list ${list.title}`}
          >
            <Icon name="trash" size={14} />
          </button>
        )}
      </header>

      <div ref={setNodeRef} className={`column__body ${isOver ? 'column__body--over' : ''}`}>
        <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          {cards.map((card) => (
            <CardTile
              key={card.id}
              card={card}
              people={people}
              disabled={!canEdit}
              onOpen={onOpenCard}
            />
          ))}
        </SortableContext>

        {cards.length === 0 && !adding && <p className="column__empty">Nothing here yet</p>}

        {adding ? (
          <textarea
            ref={inputRef}
            className="composer"
            rows={2}
            autoFocus
            value={draft}
            placeholder="What needs doing?"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submitCard();
              }
              if (e.key === 'Escape') {
                setDraft('');
                setAdding(false);
              }
            }}
          />
        ) : (
          canEdit && (
            <button type="button" className="column__add" onClick={() => setAdding(true)}>
              <Icon name="plus" size={14} /> Add card
            </button>
          )
        )}
      </div>
    </section>
  );
}
