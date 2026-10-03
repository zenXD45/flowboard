import { useEffect, useRef, useState } from 'react';
import Avatar from './Avatar.jsx';
import Icon from './Icon.jsx';
import { useBoard } from '../context/BoardContext.jsx';
import { emit } from '../lib/socket.js';

const VERB_TEXT = {
  'board.created': 'created the board',
  'board.updated': 'updated board details',
  'member.added': 'added {username} as {role}',
  'member.removed': 'removed {username}',
  'member.role': 'made {username} a {role}',
  'list.created': 'added the list “{title}”',
  'list.renamed': 'renamed a list to “{title}”',
  'list.moved': 'reordered a list',
  'list.deleted': 'deleted a list',
  'card.created': 'added “{title}”',
  'card.moved': 'moved “{title}”',
  'card.updated': 'edited “{title}”',
  'card.assigned': 'reassigned “{title}”',
  'card.deleted': 'deleted “{title}”',
  'comment.added': 'commented on “{title}”'
};

function describe(entry) {
  const template = VERB_TEXT[entry.verb] || entry.verb;
  return template.replace(/\{(\w+)\}/g, (_, key) => entry.meta?.[key] ?? '');
}

function when(iso) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function CardDetail({ cardId, onClose, selfId }) {
  const { cards, board, boardId, people, canEdit, commentsFor, updateCard, deleteCard, toast } = useBoard();
  const card = cards.find((c) => c.id === cardId);

  const [title, setTitle] = useState(card?.title || '');
  const [description, setDescription] = useState(card?.description || '');
  const [draft, setDraft] = useState('');
  const dialogRef = useDialog(onClose);

  useEffect(() => {
    setTitle(card?.title || '');
    setDescription(card?.description || '');
  }, [cardId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!card || !board) return null;

  const comments = commentsFor(cardId);
  const assignee = card.assigneeId ? people[card.assigneeId] : null;

  const save = async () => {
    const patch = {};
    const trimmed = title.trim();
    if (trimmed && trimmed !== card.title) patch.title = trimmed;
    if (description !== card.description) patch.description = description;
    if (Object.keys(patch).length === 0) return;
    await updateCard(card.id, patch);
  };

  const sendComment = async () => {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    try {
      const ack = await emit('comment:add', { boardId, cardId: card.id, body });
      if (ack?.status === 'error') {
        setDraft(body);
        toast(ack.message || 'That comment was not accepted');
      }
    } catch (err) {
      // Never swallow this: a silently restored draft looks like the app is broken.
      setDraft(body);
      toast(err.message || 'Could not post the comment');
    }
  };

  return (
    <div ref={dialogRef} className="sheet" role="dialog" aria-modal="true" aria-label={card.title}>
      <header className="sheet__head">
        <input
          className="sheet__title"
          value={title}
          disabled={!canEdit}
          maxLength={140}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <button type="button" className="iconbtn" onClick={onClose} aria-label="Close">
          <Icon name="close" size={16} />
        </button>
      </header>

      <div className="sheet__body">
        <textarea
          className="sheet__desc"
          rows={6}
          value={description}
          disabled={!canEdit}
          placeholder="Add more detail…"
          maxLength={4000}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={save}
        />

        <dl className="meta">
          <dt>Assignee</dt>
          <dd>
            {canEdit ? (
              <select
                value={card.assigneeId || ''}
                onChange={(e) => updateCard(card.id, { assigneeId: e.target.value || null })}
              >
                <option value="">Unassigned</option>
                {board.members.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {people[m.userId]?.username || m.userId}
                  </option>
                ))}
              </select>
            ) : (
              (assignee?.username ?? 'Unassigned')
            )}
          </dd>

          <dt>Due</dt>
          <dd>
            {canEdit ? (
              <input
                type="date"
                value={card.dueDate ? new Date(card.dueDate).toISOString().slice(0, 10) : ''}
                onChange={(e) => updateCard(card.id, { dueDate: e.target.value || null })}
              />
            ) : (
              (card.dueDate ? new Date(card.dueDate).toLocaleDateString() : '—')
            )}
          </dd>

          <dt>Labels</dt>
          <dd className="meta__labels">
            {(card.labels || []).length === 0 && !canEdit ? <span className="muted">none</span> : null}
            {(card.labels || []).map((name) => (
              <span key={name} className="label">
                {name}
              </span>
            ))}
            {canEdit && (
              <input
                className="meta__addlabel"
                placeholder="add label ⏎"
                maxLength={24}
                onKeyDown={async (e) => {
                  const value = e.currentTarget.value.trim().toLowerCase();
                  if (e.key === 'Enter' && value && !card.labels.includes(value)) {
                    e.currentTarget.value = '';
                    await updateCard(card.id, { labels: [...card.labels, value] });
                  }
                }}
              />
            )}
          </dd>

          <dt>Revision</dt>
          <dd className="muted">
            v{card.version} · {when(card.updatedAt)}
          </dd>
        </dl>

        <section className="comments">
          <h3>
            <Icon name="card" size={13} /> Discussion
          </h3>
          {comments.length === 0 && <p className="muted">No comments yet.</p>}
          {comments.map((c) => (
            <div key={c.id} className="comment">
              <Avatar
                userId={c.authorId}
                username={people[c.authorId]?.username || c.authorName}
                displayName={people[c.authorId]?.displayName}
                avatar={people[c.authorId]?.avatar}
                avatarColor={people[c.authorId]?.avatarColor}
                size={22}
              />
              <div>
                <p className="comment__meta">
                  <strong>{people[c.authorId]?.displayName || people[c.authorId]?.username || c.authorName || 'Someone'}</strong> · {when(c.createdAt)}
                </p>
                <p className="comment__body">{c.body}</p>
              </div>
            </div>
          ))}
          {canEdit && (
            <div className="comment__composer">
              <textarea
                rows={2}
                value={draft}
                placeholder="Write a comment…"
                maxLength={2000}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendComment();
                  }
                }}
              />
              <button type="button" className="btn btn--ghost" onClick={sendComment}>
                Comment
              </button>
            </div>
          )}
        </section>

        {canEdit ? (
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => {
              deleteCard(card.id);
              onClose();
            }}
          >
            <Icon name="trash" size={14} /> Delete card
          </button>
        ) : (
          <p className="muted">You have view-only access to this board.</p>
        )}
        {!selfId && null}
      </div>
    </div>
  );
}

function PeoplePanel({ onClose, selfId }) {
  const { board, people, role, addMember, setMemberRole, removeMember } = useBoard();
  const [username, setUsername] = useState('');
  const [newRole, setNewRole] = useState('member');
  const isOwner = role === 'owner';
  const dialogRef = useDialog(onClose);

  const submit = async () => {
    const value = username.trim();
    if (!value) return;
    if (await addMember(value, newRole)) setUsername('');
  };

  return (
    <div ref={dialogRef} className="sheet sheet--narrow" role="dialog" aria-modal="true" aria-label="People">
      <header className="sheet__head">
        <h2>
          <Icon name="users" size={16} /> People
        </h2>
        <button type="button" className="iconbtn" onClick={onClose} aria-label="Close">
          <Icon name="close" size={16} />
        </button>
      </header>

      <div className="sheet__body">
        <ul className="people">
          {board?.members.map((m) => (
            <li key={m.userId}>
              <Avatar
                userId={m.userId}
                username={people[m.userId]?.username}
                displayName={people[m.userId]?.displayName}
                avatar={people[m.userId]?.avatar}
                avatarColor={people[m.userId]?.avatarColor}
                size={30}
              />
              <div className="people__who">
                <strong>{people[m.userId]?.displayName || people[m.userId]?.username || m.userId}</strong>
                {m.userId === selfId && <span className="muted"> you</span>}
              </div>
              {m.role === 'owner' || !isOwner ? (
                <span className="chip">{m.role}</span>
              ) : (
                <select value={m.role} onChange={(e) => setMemberRole(m.userId, e.target.value)}>
                  <option value="member">member</option>
                  <option value="viewer">viewer</option>
                </select>
              )}
              {isOwner && m.role !== 'owner' && (
                <button
                  type="button"
                  className="iconbtn"
                  onClick={() => removeMember(m.userId)}
                  aria-label={`Remove ${people[m.userId]?.username}`}
                >
                  <Icon name="trash" size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>

        {isOwner ? (
          <div className="invite">
            <input
              value={username}
              placeholder="username"
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
            <select value={newRole} onChange={(e) => setNewRole(e.target.value)}>
              <option value="member">can edit</option>
              <option value="viewer">view only</option>
            </select>
            <button type="button" className="btn" onClick={submit}>
              <Icon name="plus" size={14} /> Add
            </button>
          </div>
        ) : (
          <p className="muted">Ask the board owner to add people.</p>
        )}
      </div>
    </div>
  );
}

function ActivityPanel({ onClose }) {
  const dialogRef = useDialog(onClose);
  const { activity, hasMoreActivity, loadMoreActivity } = useBoard();

  return (
    <div ref={dialogRef} className="sheet sheet--narrow" role="dialog" aria-modal="true" aria-label="Activity">
      <header className="sheet__head">
        <h2>
          <Icon name="history" size={16} /> Activity
        </h2>
        <button type="button" className="iconbtn" onClick={onClose} aria-label="Close">
          <Icon name="close" size={16} />
        </button>
      </header>

      <div className="sheet__body">
        <ol className="feed">
          {activity.map((entry) => (
            <li key={entry.id}>
              <span className="feed__dot" />
              <p>
                <strong>{entry.actorName}</strong> {describe(entry)}
              </p>
              <time dateTime={entry.createdAt}>{when(entry.createdAt)}</time>
            </li>
          ))}
        </ol>
        {activity.length === 0 && <p className="muted">Nothing has happened yet.</p>}
        {hasMoreActivity && (
          <button type="button" className="btn btn--ghost" onClick={loadMoreActivity}>
            Load older
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Every sheet shares the same dialog contract: Escape dismisses, Tab is trapped
 * inside the panel, and focus lands on the panel when it opens and returns to
 * the trigger when it closes. Without this the sheets are unusable by keyboard.
 */
function useDialog(onClose) {
  const ref = useRef(null);

  useEffect(() => {
    const node = ref.current;
    const opener = document.activeElement;
    const focusable = () =>
      [...node.querySelectorAll('button, input, textarea, select, [tabindex]:not([tabindex="-1"])')].filter(
        (el) => !el.disabled && el.offsetParent !== null
      );

    node?.querySelector('[data-autofocus], input, textarea, button')?.focus();

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [onClose]);

  return ref;
}

export default function BoardPanel({ panel, onClose, selfId }) {
  if (panel.kind === 'card') return <CardDetail cardId={panel.cardId} onClose={onClose} selfId={selfId} />;
  if (panel.kind === 'people') return <PeoplePanel onClose={onClose} selfId={selfId} />;
  if (panel.kind === 'activity') return <ActivityPanel onClose={onClose} />;
  return null;
}
