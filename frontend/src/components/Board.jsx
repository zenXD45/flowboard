import { useCallback, useState } from 'react';
import { DndContext, closestCorners, DragOverlay, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import Column from './Column.jsx';
import Avatar from './Avatar.jsx';
import Icon from './Icon.jsx';
import Toasts from './Toasts.jsx';
import BoardPanel from './BoardPanel.jsx';
import { useBoard } from '../context/BoardContext.jsx';

function PresenceBar({ presence, people, selfId }) {
  if (!presence.length) return null;
  const others = presence.filter((p) => p.userId !== selfId);
  return (
    <div className="presence" title={presence.map((p) => p.username).join(', ')}>
      <span className={`presence__dot ${others.length === 0 ? 'presence__dot--alone' : ''}`} />
      {presence.slice(0, 5).map((p) => {
        const profile = people[p.userId];
        return (
          <Avatar
            key={p.userId}
            userId={p.userId}
            username={profile?.username || p.username}
            avatar={profile?.avatar || p.avatar}
            size={26}
            title={p.userId === selfId ? 'You' : profile?.username || p.username}
          />
        );
      })}
      <span className="presence__label">{others.length === 0 ? 'only you' : `${others.length + 1} here`}</span>
    </div>
  );
}

export default function Board({ selfId }) {
  const {
    board,
    cards,
    canEdit,
    cardsByList,
    people,
    presence,
    toasts,
    dismissToast,
    connection,
    moveCard,
    createCard,
    createList,
    renameList,
    deleteList
  } = useBoard();

  const [dragging, setDragging] = useState(null);
  const [panel, setPanel] = useState(null);

  // A small activation distance keeps a click on a card from starting a drag,
  // which otherwise swallows the double-click that opens the card.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  /**
   * The drop index is always computed against the list *with the dragged card
   * removed* — the same thing the server does in resolvePosition(..., excludeCardId).
   * Sending the same coordinate system to both ends is what stops the card from
   * landing one slot off when you drag it within its own list.
   */
  const findPlacement = useCallback(
    (activeId, overId) => {
      const dragged = cards.find((c) => c.id === activeId);
      if (!dragged) return null;

      const siblingsFor = (listId) => cardsByList(listId).filter((c) => c.id !== activeId);

      if (typeof overId === 'string' && overId.startsWith('list:')) {
        const listId = overId.slice(5);
        return { cardId: activeId, listId, index: siblingsFor(listId).length };
      }

      const target = cards.find((c) => c.id === overId);
      if (!target) return null;

      const siblings = siblingsFor(target.listId);
      const index = siblings.findIndex((c) => c.id === target.id);
      if (index === -1) return null;

      return { cardId: activeId, listId: target.listId, index };
    },
    [cards, cardsByList]
  );

  const draggingCard = dragging ? cards.find((c) => c.id === dragging) : null;

  return (
    <div className="board-shell">
      <header className="topbar">
        <div className="topbar__left">
          <h1 className="topbar__title">{board?.title}</h1>
          {board?.description && <p className="topbar__sub">{board.description}</p>}
        </div>
        <div className="topbar__right">
          {!connection.connected && (
            <span className="pill pill--warn">
              <Icon name="clock" size={12} /> {connection.error ? 'Offline' : 'Connecting…'}
            </span>
          )}
          <PresenceBar presence={presence} people={people} selfId={selfId} />
          <button type="button" className="ghostbtn" data-testid="open-activity" onClick={() => setPanel({ kind: 'activity' })}>
            <Icon name="history" size={14} /> Activity
          </button>
          <button type="button" className="ghostbtn" data-testid="open-people" onClick={() => setPanel({ kind: 'people' })}>
            <Icon name="users" size={14} /> People
          </button>
        </div>
      </header>

      {panel && (
          <button
            type="button"
            className="scrim"
            aria-label="Close panel"
            onClick={() => setPanel(null)}
          />
        )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={({ active }) => setDragging(active.id)}
        onDragCancel={() => setDragging(null)}
        onDragEnd={({ active, over }) => {
          setDragging(null);
          if (!over || !canEdit) return;
          const placement = findPlacement(active.id, over.id);
          if (!placement) return;

          const currentIndex = cardsByList(placement.listId).findIndex((c) => c.id === placement.cardId);
          if (currentIndex === placement.index) return;

          moveCard(placement.cardId, placement.listId, placement.index);
        }}
      >
        <div className="board">
          {board?.lists.map((list) => (
            <Column
              key={list.id}
              list={list}
              cards={cardsByList(list.id)}
              people={people}
              canEdit={canEdit}
              onOpenCard={(card) => setPanel({ kind: 'card', cardId: card.id })}
              onCreateCard={createCard}
              onRename={renameList}
              onDelete={deleteList}
            />
          ))}

          {canEdit && (
            <button type="button" className="addlist" onClick={() => createList('New list')}>
              <Icon name="plus" size={15} /> Add list
            </button>
          )}
        </div>

        <DragOverlay>{draggingCard ? <div className="card card--overlay"><p className="card__title">{draggingCard.title}</p></div> : null}</DragOverlay>
      </DndContext>

      {panel && <BoardPanel panel={panel} onClose={() => setPanel(null)} selfId={selfId} />}

      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
