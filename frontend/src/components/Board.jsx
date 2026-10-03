import { useCallback, useState } from 'react';
import {
  DndContext,
  closestCorners,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import Column from './Column.jsx';
import Avatar from './Avatar.jsx';
import AvatarMenu from './AvatarMenu.jsx';
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
            displayName={profile?.displayName || p.displayName}
            avatar={profile?.avatar || p.avatar}
            avatarColor={profile?.avatarColor || p.avatarColor}
            size={26}
            title={p.userId === selfId ? 'You' : profile?.displayName || profile?.username || p.displayName || p.username}
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

  /**
   * Three sensors, because one gesture has to mean two different things
   * depending on what is under the finger.
   *
   * A single PointerSensor cannot do this. On touch it competes with the
   * browser's own panning: either the drag eats the scroll (the column becomes
   * unscrollable) or the scroll cancels the drag (cards cannot be moved at
   * all). Measured on a Pixel 7 viewport, both were true — a horizontal drag
   * moved nothing, scrolled the board, and at the scroll boundary Chrome
   * treated the leftover gesture as an overscroll and fired a history Back,
   * ejecting the user off the board entirely.
   *
   * So the two inputs are separated:
   *
   *   mouse    6px of travel starts a drag, so a click is still a click
   *   touch    200ms hold starts a drag, so a flick still scrolls and a tap
   *            still opens the card — the gesture is only claimed once the
   *            user has clearly held still to say "I mean to move this"
   *   keyboard space lifts, arrows move, space drops (sortable coordinates)
   *
   * Keyboard dragging was previously claimed in the design notes but never
   * actually wired up: there was no KeyboardSensor, so a keyboard user could
   * open a card with Enter but could not move one.
   */
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

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
          <AvatarMenu />
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
          {board?.lists.map((list, index) => (
            <Column
              key={list.id}
              list={list}
              index={index}
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
