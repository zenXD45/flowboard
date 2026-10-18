import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { SortableContext, horizontalListSortingStrategy, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
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
    deleteList,
    moveList,
    exportBoard
  } = useBoard();

  const [dragging, setDragging] = useState(null);
  const [panel, setPanel] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedLabel, setSelectedLabel] = useState('');
  const [dueFilter, setDueFilter] = useState('');
  const searchInputRef = useRef(null);

  // Global '/' shortcut to focus search input
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target?.tagName)) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const allLabels = useMemo(() => {
    const set = new Set();
    for (const c of cards) {
      for (const l of c.labels || []) set.add(l);
    }
    return Array.from(set).sort();
  }, [cards]);

  const isFiltered = Boolean(searchQuery.trim() || selectedLabel || dueFilter);

  const clearFilters = useCallback(() => {
    setSearchQuery('');
    setSelectedLabel('');
    setDueFilter('');
  }, []);

  const filteredCards = useMemo(() => {
    let result = cards;
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      result = result.filter(
        (c) =>
          c.title?.toLowerCase().includes(q) ||
          c.description?.toLowerCase().includes(q)
      );
    }
    if (selectedLabel) {
      result = result.filter((c) => c.labels?.includes(selectedLabel));
    }
    if (dueFilter) {
      result = result.filter((c) => {
        if (!c.dueDate) return false;
        const days = Math.ceil((new Date(c.dueDate) - Date.now()) / 86_400_000);
        if (dueFilter === 'soon') return days >= 0 && days <= 2;
        if (dueFilter === 'overdue') return days < 0;
        return true;
      });
    }
    return result;
  }, [cards, searchQuery, selectedLabel, dueFilter]);

  const cardsByListFiltered = useCallback(
    (listId) => {
      const inList = filteredCards.filter((c) => c.listId === listId);
      return inList.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    },
    [filteredCards]
  );

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

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

  const handleDragStart = ({ active }) => {
    if (active.data.current?.type === 'column') {
      setDragging({ type: 'column', id: active.id, list: active.data.current.list });
    } else {
      setDragging({ type: 'card', id: active.id, card: cards.find((c) => c.id === active.id) });
    }
  };

  const handleDragEnd = ({ active, over }) => {
    setDragging(null);
    if (!over || !canEdit) return;

    if (active.data.current?.type === 'column') {
      if (active.id === over.id) return;
      const oldIndex = board?.lists.findIndex((l) => l.id === active.id);
      const newIndex = board?.lists.findIndex((l) => l.id === over.id);
      if (oldIndex != null && newIndex != null && oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        moveList(active.id, newIndex);
      }
      return;
    }

    const placement = findPlacement(active.id, over.id);
    if (!placement) return;

    const currentIndex = cardsByList(placement.listId).findIndex((c) => c.id === placement.cardId);
    if (currentIndex === placement.index) return;

    moveCard(placement.cardId, placement.listId, placement.index);
  };

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
          <button
            type="button"
            className="ghostbtn"
            data-testid="export-board"
            onClick={exportBoard}
            title="Export board as JSON"
          >
            <Icon name="download" size={14} /> Export
          </button>
          <AvatarMenu />
        </div>
      </header>

      <div className="filterbar">
        <div className="filterbar__search">
          <Icon name="search" size={13} className="filterbar__search-icon" />
          <input
            ref={searchInputRef}
            type="search"
            className="filterbar__input"
            placeholder="Search cards… (Press /)"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setSearchQuery('');
                e.currentTarget.blur();
              }
            }}
          />
          {searchQuery && (
            <button
              type="button"
              className="iconbtn filterbar__clear-search"
              onClick={() => setSearchQuery('')}
              aria-label="Clear search"
            >
              <Icon name="close" size={11} />
            </button>
          )}
        </div>

        <div className="filterbar__filters">
          {allLabels.length > 0 && (
            <div className="filterbar__group">
              <span className="filterbar__label">Labels:</span>
              {allLabels.map((lbl) => (
                <button
                  key={lbl}
                  type="button"
                  className={`filterchip ${selectedLabel === lbl ? 'filterchip--active' : ''}`}
                  onClick={() => setSelectedLabel(selectedLabel === lbl ? '' : lbl)}
                >
                  {lbl}
                </button>
              ))}
            </div>
          )}

          <div className="filterbar__group">
            <span className="filterbar__label">Due:</span>
            <button
              type="button"
              className={`filterchip ${dueFilter === 'soon' ? 'filterchip--active' : ''}`}
              onClick={() => setDueFilter(dueFilter === 'soon' ? '' : 'soon')}
            >
              <Icon name="clock" size={11} /> Soon
            </button>
            <button
              type="button"
              className={`filterchip ${dueFilter === 'overdue' ? 'filterchip--active' : ''}`}
              onClick={() => setDueFilter(dueFilter === 'overdue' ? '' : 'overdue')}
            >
              Overdue
            </button>
          </div>

          {isFiltered && (
            <div className="filterbar__actions">
              <span className="filterbar__count">
                {filteredCards.length} of {cards.length} cards
              </span>
              <button type="button" className="ghostbtn filterbar__reset" onClick={clearFilters}>
                <Icon name="close" size={12} /> Clear
              </button>
            </div>
          )}
        </div>
      </div>

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
        onDragStart={handleDragStart}
        onDragCancel={() => setDragging(null)}
        onDragEnd={handleDragEnd}
      >
        <div className="board">
          <SortableContext
            items={board?.lists?.map((l) => l.id) || []}
            strategy={horizontalListSortingStrategy}
          >
            {board?.lists.map((list, index) => (
              <Column
                key={list.id}
                list={list}
                index={index}
                cards={cardsByListFiltered(list.id)}
                people={people}
                canEdit={canEdit}
                onOpenCard={(card) => setPanel({ kind: 'card', cardId: card.id })}
                onCreateCard={createCard}
                onRename={renameList}
                onDelete={deleteList}
              />
            ))}
          </SortableContext>

          {canEdit && (
            <button type="button" className="addlist" onClick={() => createList('New list')}>
              <Icon name="plus" size={15} /> Add list
            </button>
          )}
        </div>

        <DragOverlay>
          {dragging?.type === 'card' && dragging.card ? (
            <div className="card card--overlay">
              <p className="card__title">{dragging.card.title}</p>
            </div>
          ) : dragging?.type === 'column' && dragging.list ? (
            <div className="column column--overlay">
              <header className="column__head">
                <span className="column__title">{dragging.list.title}</span>
              </header>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {panel && <BoardPanel panel={panel} onClose={() => setPanel(null)} selfId={selfId} />}

      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
