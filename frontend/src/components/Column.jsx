import { useRef, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import CardTile from './CardTile.jsx';
import Icon from './Icon.jsx';

export default function Column({ list, cards, people, canEdit, index = 0, onOpenCard, onCreateCard, onRename, onDelete }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [title, setTitle] = useState(list.title);
  const inputRef = useRef(null);

  const {
    attributes: colAttributes,
    listeners: colListeners,
    setNodeRef: setColRef,
    transform: colTransform,
    transition: colTransition,
    isDragging: isColDragging
  } = useSortable({
    id: list.id,
    data: { type: 'column', list },
    disabled: !canEdit
  });

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

  // Deleting a list destroys every card in it. One tap used to be enough,
  // which is survivable when you can hover the button and read its title, and
  // reckless on a phone where there is no hover and a mis-tap is one thumb
  // away. Two taps, and the second one says what it destroys.
  const requestDelete = () => {
    if (confirmingDelete) {
      setConfirmingDelete(false);
      onDelete(list.id);
      return;
    }
    setConfirmingDelete(true);
  };

  return (
    <section
      ref={setColRef}
      className={`column ${isColDragging ? 'column--dragging' : ''}`}
      aria-label={list.title}
      style={{
        transform: CSS.Translate.toString(colTransform),
        transition: colTransition,
        '--col': index
      }}
    >
      <header className="column__head">
        {canEdit && (
          <button
            type="button"
            className="iconbtn column__drag-handle"
            aria-label={`Drag to reorder list ${list.title}`}
            title="Drag to reorder list"
            {...colAttributes}
            {...colListeners}
          >
            <Icon name="grip" size={13} />
          </button>
        )}
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
        {canEdit &&
          (confirmingDelete ? (
            <span className="column__confirm">
              <button
                type="button"
                className="btn btn--danger btn--tiny"
                onClick={requestDelete}
                // Escape and a click elsewhere both back out, so the armed
                // state can never be left hanging over the board.
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setConfirmingDelete(false);
                }}
              >
                {cards.length > 0 ? `Delete list + ${cards.length} card${cards.length === 1 ? '' : 's'}` : 'Delete list'}
              </button>
              <button
                type="button"
                className="iconbtn"
                onClick={() => setConfirmingDelete(false)}
                aria-label="Keep list"
                title="Keep this list"
              >
                <Icon name="close" size={14} />
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="iconbtn"
              onClick={requestDelete}
              title="Delete list and its cards"
              aria-label={`Delete list ${list.title}`}
            >
              <Icon name="trash" size={14} />
            </button>
          ))}
      </header>

      <div ref={setNodeRef} className={`column__body ${isOver ? 'column__body--over' : ''}`}>
        <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          {cards.map((card, i) => (
            <CardTile
              key={card.id}
              card={card}
              index={i}
              people={people}
              disabled={!canEdit}
              onOpen={onOpenCard}
            />
          ))}
        </SortableContext>

        {cards.length === 0 && !adding && (
          // An empty column is the most common state a new board is in, so it
          // gets a real affordance rather than a placeholder sentence: it says
          // what belongs here and offers the exact control that adds it.
          <div className="column__blank">
            {canEdit ? (
              <>
                <p className="column__blank-text">Drop a card here</p>
                <button type="button" className="column__blank-cta" onClick={() => setAdding(true)}>
                  <Icon name="plus" size={13} /> Add a card
                </button>
              </>
            ) : (
              <p className="column__blank-text">Nothing here yet</p>
            )}
          </div>
        )}

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
