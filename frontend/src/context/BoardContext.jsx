import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { api } from '../lib/api.js';
import { getSocket, mutate, onStatus } from '../lib/socket.js';
import { groupByList, positionBetween, sortByPosition } from '../lib/positions.js';
import { useAuth } from './AuthContext.jsx';

const BoardContext = createContext(null);

const EMPTY_TOASTS = [];
const EMPTY_COMMENTS = [];
let toastSeq = 0;

/** Comments are stored per card so opening any card is a map read, not a query. */
const groupComments = (list) =>
  list.reduce((acc, comment) => {
    (acc[comment.cardId] ||= []).push(comment);
    return acc;
  }, {});

export function BoardProvider({ boardId, children }) {
  const { user } = useAuth();
  const [board, setBoard] = useState(null);
  const [role, setRole] = useState('');
  const [cards, setCards] = useState({});
  const [comments, setComments] = useState({});
  const [people, setPeople] = useState({});
  const [presence, setPresence] = useState([]);
  const [activity, setActivity] = useState([]);
  const [activityCursor, setActivityCursor] = useState(null);
  const [activityDone, setActivityDone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState('');
  const [toasts, setToasts] = useState(EMPTY_TOASTS);
  const [connection, setConnection] = useState({ connected: false, error: '' });
  const [cardEditors, setCardEditors] = useState({});

  // The socket event handlers below are registered once but need current data.
  // Reading through refs keeps the listeners stable without re-subscribing
  // every time a card moves.
  const cardsRef = useRef(cards);
  cardsRef.current = cards;

  const toast = useCallback((message, tone = 'info') => {
    toastSeq += 1;
    const id = toastSeq;
    setToasts((prev) => [...prev, { id, message, tone }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4200);
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const nameOf = useCallback(
    (userId) => people[userId]?.username || presence.find((p) => p.userId === userId)?.username || 'Someone',
    [people, presence]
  );

  // ------------------------------------------------------------- bootstrap

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFatal('');

    async function load() {
      try {
        const snapshot = await api.board(boardId);
        if (cancelled) return;
        setBoard(snapshot.board);
        setRole(snapshot.role);
        setCards(Object.fromEntries(snapshot.cards.map((c) => [c.id, c])));
        setComments(groupComments(snapshot.comments || []));
        setPeople(snapshot.people);

        const socket = getSocket();
        const join = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Could not reach the server')), 8000);
          socket.emit('board:join', { boardId }, (ack) => {
            clearTimeout(timer);
            resolve(ack);
          });
        });
        if (join.status === 'error') throw new Error(join.message);
        if (!cancelled) setRole(join.role);

        const feed = await api.activity(boardId);
        if (cancelled) return;
        setActivity(feed.activity);
        setActivityCursor(feed.nextBefore);
        setActivityDone(!feed.hasMore);
      } catch (err) {
        if (!cancelled) setFatal(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [boardId]);

  // ------------------------------------------------------- socket wiring

  useEffect(() => {
    const offStatus = onStatus((s) => setConnection({ connected: s.connected, error: s.error }));
    const socket = getSocket();
    if (!socket) return offStatus;

    const upsert = (incoming) =>
      setCards((prev) => ({ ...prev, [incoming.id]: { ...prev[incoming.id], ...incoming } }));

    const handlers = {
      'card:created': ({ card }) => setCards((prev) => (prev[card.id] ? prev : { ...prev, [card.id]: card })),
      'card:updated': ({ card }) => upsert(card),
      'card:moved': ({ card }) => upsert(card),
      'card:deleted': ({ cardId }) =>
        setCards((prev) => {
          const next = { ...prev };
          delete next[cardId];
          return next;
        }),
      'card:focused': ({ cardId, userId, username }) =>
        setCardEditors((prev) => {
          const list = prev[cardId] || [];
          if (list.some((u) => u.userId === userId)) return prev;
          return { ...prev, [cardId]: [...list, { userId, username }] };
        }),
      'card:blurred': ({ cardId, userId }) =>
        setCardEditors((prev) => {
          const list = prev[cardId] || [];
          const nextList = list.filter((u) => u.userId !== userId);
          if (nextList.length === 0) {
            const next = { ...prev };
            delete next[cardId];
            return next;
          }
          return { ...prev, [cardId]: nextList };
        }),
      'list:created': ({ list }) =>
        setBoard((prev) => (prev ? { ...prev, lists: sortByPosition([...prev.lists, list]) } : prev)),
      'list:renamed': ({ listId, title }) =>
        setBoard((prev) =>
          prev ? { ...prev, lists: prev.lists.map((l) => (l.id === listId ? { ...l, title } : l)) } : prev
        ),
      'list:moved': ({ listId, position }) =>
        setBoard((prev) =>
          prev
            ? { ...prev, lists: sortByPosition(prev.lists.map((l) => (l.id === listId ? { ...l, position } : l))) }
            : prev
        ),
      'list:deleted': ({ listId, removedCardIds }) => {
        setBoard((prev) => (prev ? { ...prev, lists: prev.lists.filter((l) => l.id !== listId) } : prev));
        setCards((prev) => {
          const next = { ...prev };
          for (const id of removedCardIds || []) delete next[id];
          return next;
        });
        setComments((prev) => {
          const next = { ...prev };
          for (const id of removedCardIds || []) delete next[id];
          return next;
        });
      },
      'board:updated': ({ patch }) =>
        setBoard((prev) => (prev ? { ...prev, ...patch } : prev)),
      'member:added': ({ member }) => {
        setBoard((prev) =>
          prev ? { ...prev, members: [...prev.members, { userId: member.userId, role: member.role }] } : prev
        );
        setPeople((prev) => ({
          ...prev,
          [member.userId]: { username: member.username, avatar: member.avatar }
        }));
      },
      'member:role': ({ userId, role: nextRole }) => {
        setBoard((prev) =>
          prev
            ? { ...prev, members: prev.members.map((m) => (m.userId === userId ? { ...m, role: nextRole } : m)) }
            : prev
        );
        if (userId === user?.id) setRole(nextRole);
      },
      'member:removed': ({ userId }) => {
        setBoard((prev) => (prev ? { ...prev, members: prev.members.filter((m) => m.userId !== userId) } : prev));
        if (userId === user?.id) setFatal('You were removed from this board.');
      },
      'presence:sync': (payload) => {
        if (payload.boardId === boardId) setPresence(payload.users);
      },
      'comment:new': ({ comment }) => {
        setComments((prev) => {
          const existing = prev[comment.cardId];
          // The author already appended it optimistically; keyed ids keep the
          // reply echo from appearing twice.
          if (existing?.some((c) => c.id === comment.id)) return prev;
          return { ...prev, [comment.cardId]: [...(existing || []), comment] };
        });
        setPeople((prev) =>
          prev[comment.authorId]
            ? prev
            : { ...prev, [comment.authorId]: { username: comment.authorName || 'Someone', avatar: '' } }
        );
      },
      'activity:new': (entry) => setActivity((prev) => [entry, ...prev].slice(0, 100)),
      'board:deleted': () => setFatal('This board was deleted.')
    };

    for (const [event, handler] of Object.entries(handlers)) socket.on(event, handler);
    return () => {
      offStatus();
      for (const [event, handler] of Object.entries(handlers)) socket.off(event, handler);
      socket.emit('board:leave', { boardId });
    };
  }, [boardId, user?.id]);

  // ------------------------------------------------------------ mutations

  /**
   * The one interaction where latency is actually felt. We place the card
   * locally, then reconcile against whatever the server says:
   *   ok        -> adopt the server's position and bumped version
   *   conflict  -> adopt the server's card and tell the user who won
   *   transport -> put the card back exactly where it was
   */
  const moveCard = useCallback(
    async (cardId, toListId, index) => {
      const before = cardsRef.current[cardId];
      if (!before) return;

      setCards((prev) => {
        const siblings = sortByPosition(
          Object.values(prev).filter((c) => c.listId === toListId && c.id !== cardId)
        );
        const clamped = Math.min(Math.max(index, 0), siblings.length);
        const position = positionBetween(
          clamped > 0 ? siblings[clamped - 1].position : null,
          clamped < siblings.length ? siblings[clamped].position : null
        );
        return { ...prev, [cardId]: { ...prev[cardId], listId: toListId, position, _pending: true } };
      });

      try {
        const ack = await mutate('card:move', {
          boardId,
          cardId,
          toListId,
          index,
          expectedVersion: before.version
        });
        setCards((prev) => ({ ...prev, [cardId]: { ...ack.card, _pending: false } }));
      } catch (err) {
        if (err.conflict) {
          setCards((prev) => ({ ...prev, [cardId]: { ...err.card, _pending: false } }));
          toast('Someone moved this card first — showing their version');
        } else {
          setCards((prev) => ({ ...prev, [cardId]: { ...before, _pending: false } }));
          toast(err.message, 'error');
        }
      }
    },
    [boardId, toast]
  );

  const createCard = useCallback(
    async (listId, title, index) => {
      const trimmed = title.trim();
      if (!trimmed) return null;
      try {
        const ack = await mutate('card:create', { boardId, listId, title: trimmed, index });
        setCards((prev) => ({ ...prev, [ack.card.id]: ack.card }));
        return ack.card;
      } catch (err) {
        toast(err.message, 'error');
        return null;
      }
    },
    [boardId, toast]
  );

  const updateCard = useCallback(
    async (cardId, patch) => {
      const before = cardsRef.current[cardId];
      if (!before) return false;
      setCards((prev) => ({ ...prev, [cardId]: { ...prev[cardId], ...patch, _pending: true } }));
      try {
        const ack = await mutate('card:update', { boardId, cardId, patch, expectedVersion: before.version });
        setCards((prev) => ({ ...prev, [cardId]: { ...ack.card, _pending: false } }));
        return true;
      } catch (err) {
        if (err.conflict) {
          setCards((prev) => ({ ...prev, [cardId]: { ...err.card, _pending: false } }));
          toast('Someone edited this card first — showing their version');
        } else {
          setCards((prev) => ({ ...prev, [cardId]: { ...before, _pending: false } }));
          toast(err.message, 'error');
        }
        return false;
      }
    },
    [boardId, toast]
  );

  const deleteCard = useCallback(
    async (cardId) => {
      try {
        await mutate('card:delete', { boardId, cardId });
      } catch (err) {
        toast(err.message, 'error');
      }
    },
    [boardId, toast]
  );

  const createList = useCallback(
    async (title) => {
      try {
        const ack = await mutate('list:create', { boardId, title });
        setBoard((prev) => (prev ? { ...prev, lists: sortByPosition([...prev.lists, ack.list]) } : prev));
        return ack.list;
      } catch (err) {
        toast(err.message, 'error');
        return null;
      }
    },
    [boardId, toast]
  );

  const renameList = useCallback(
    async (listId, title) => {
      try {
        await mutate('list:rename', { boardId, listId, title });
      } catch (err) {
        toast(err.message, 'error');
      }
    },
    [boardId, toast]
  );

  const deleteList = useCallback(
    async (listId) => {
      try {
        await mutate('list:delete', { boardId, listId });
      } catch (err) {
        toast(err.message, 'error');
      }
    },
    [boardId, toast]
  );

  const moveList = useCallback(
    async (listId, index) => {
      const before = board?.lists;
      if (!before) return;
      const others = before.filter((l) => l.id !== listId);
      const target = before.find((l) => l.id === listId);
      if (!target) return;
      const clamped = Math.min(Math.max(index, 0), others.length);
      const nextLists = [...others];
      nextLists.splice(clamped, 0, target);
      setBoard((prev) => (prev ? { ...prev, lists: nextLists } : prev));
      try {
        const ack = await mutate('list:move', { boardId, listId, index: clamped });
        if (ack?.position != null) {
          setBoard((prev) =>
            prev
              ? {
                  ...prev,
                  lists: sortByPosition(prev.lists.map((l) => (l.id === listId ? { ...l, position: ack.position } : l)))
                }
              : prev
          );
        }
      } catch (err) {
        setBoard((prev) => (prev ? { ...prev, lists: before } : prev));
        toast(err.message, 'error');
      }
    },
    [boardId, board, toast]
  );

  const updateBoardMeta = useCallback(
    async (patch) => {
      const before = board;
      setBoard((prev) => (prev ? { ...prev, ...patch } : prev));
      try {
        await mutate('board:update', { boardId, ...patch });
      } catch (err) {
        setBoard(before);
        toast(err.message, 'error');
      }
    },
    [boardId, board, toast]
  );

  const addMember = useCallback(
    async (username, memberRole) => {
      try {
        await mutate('member:add', { boardId, username, role: memberRole });
        return true;
      } catch (err) {
        toast(err.message, 'error');
        return false;
      }
    },
    [boardId, toast]
  );

  const setMemberRole = useCallback(
    async (userId, memberRole) => {
      try {
        await mutate('member:role', { boardId, userId, role: memberRole });
      } catch (err) {
        toast(err.message, 'error');
      }
    },
    [boardId, toast]
  );

  const removeMember = useCallback(
    async (userId) => {
      try {
        await mutate('member:remove', { boardId, userId });
      } catch (err) {
        toast(err.message, 'error');
      }
    },
    [boardId, toast]
  );

  const loadMoreActivity = useCallback(async () => {
    if (activityDone || !activityCursor) return;
    try {
      const page = await api.activity(boardId, activityCursor);
      setActivity((prev) => [...prev, ...page.activity]);
      setActivityCursor(page.nextBefore);
      setActivityDone(!page.hasMore);
    } catch {
      setActivityDone(true);
    }
  }, [boardId, activityCursor, activityDone]);

  const cardsByList = useMemo(() => {
    const grouped = groupByList(Object.values(cards));
    return (listId) => grouped.get(listId) || [];
  }, [cards]);

  const focusCard = useCallback(
    (cardId) => {
      const socket = getSocket();
      if (socket?.connected && boardId && cardId) {
        socket.emit('card:focus', { boardId, cardId });
      }
    },
    [boardId]
  );

  const blurCard = useCallback(
    (cardId) => {
      const socket = getSocket();
      if (socket?.connected && boardId && cardId) {
        socket.emit('card:blur', { boardId, cardId });
      }
    },
    [boardId]
  );

  const exportBoard = useCallback(() => {
    if (!board) return;
    const listsWithCards = (board.lists || []).map((l) => {
      const listCards = cardsByList(l.id).map((c) => ({
        id: c.id,
        title: c.title,
        description: c.description || '',
        labels: c.labels || [],
        dueDate: c.dueDate || null,
        assignee: c.assigneeId ? people[c.assigneeId]?.username || c.assigneeId : null,
        version: c.version,
        comments: (comments[c.id] || []).map((cm) => ({
          author: people[cm.authorId]?.username || cm.authorName || 'Someone',
          body: cm.body,
          createdAt: cm.createdAt
        })),
        createdAt: c.createdAt,
        updatedAt: c.updatedAt
      }));
      return {
        id: l.id,
        title: l.title,
        position: l.position,
        cards: listCards
      };
    });

    const payload = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      board: {
        id: board.id,
        title: board.title,
        description: board.description || '',
        owner: people[board.ownerId]?.username || board.ownerId,
        members: (board.members || []).map((m) => ({
          username: people[m.userId]?.username || m.userId,
          role: m.role
        })),
        createdAt: board.createdAt
      },
      lists: listsWithCards
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safeTitle = (board.title || 'board').toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    a.href = url;
    a.download = `flowboard-${safeTitle}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast('Board exported to JSON');
  }, [board, cardsByList, people, comments, toast]);

  const value = useMemo(
    () => ({
      board,
      boardId,
      role,
      canEdit: role === 'owner' || role === 'member',
      isOwner: role === 'owner',
      cards: Object.values(cards),
      cardsByList,
      comments,
      commentsFor: (cardId) => comments[cardId] || EMPTY_COMMENTS,
      people,
      presence,
      cardEditors,
      focusCard,
      blurCard,
      exportBoard,
      activity,
      loadMoreActivity,
      hasMoreActivity: !activityDone,
      loading,
      fatal,
      toasts,
      toast,
      dismissToast,
      connection,
      moveCard,
      createCard,
      updateCard,
      deleteCard,
      createList,
      renameList,
      deleteList,
      moveList,
      updateBoardMeta,
      addMember,
      setMemberRole,
      removeMember,
      nameOf
    }),
    [
      board,
      boardId,
      role,
      cards,
      cardsByList,
      comments,
      people,
      presence,
      cardEditors,
      focusCard,
      blurCard,
      exportBoard,
      activity,
      loadMoreActivity,
      activityDone,
      loading,
      fatal,
      toasts,
      dismissToast,
      toast,
      connection,
      moveCard,
      createCard,
      updateCard,
      deleteCard,
      createList,
      renameList,
      deleteList,
      moveList,
      updateBoardMeta,
      addMember,
      setMemberRole,
      removeMember,
      nameOf
    ]
  );

  return <BoardContext.Provider value={value}>{children}</BoardContext.Provider>;
}

export function useBoard() {
  const ctx = useContext(BoardContext);
  if (!ctx) throw new Error('useBoard must be used inside BoardProvider');
  return ctx;
}
