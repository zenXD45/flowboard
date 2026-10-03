import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import Avatar from './Avatar.jsx';
import Icon from './Icon.jsx';

/* Labels are free-form, so a known name picks a hue token and anything else
   falls back to a neutral chip. The token pair carries both themes, which is
   what keeps chip text legible without hardcoding a hex per label. */
const LABEL_TOKENS = {
  bug: 'bug',
  p1: 'p1',
  p2: 'p2',
  p3: 'p3',
  design: 'design',
  docs: 'docs'
};

export function Label({ name }) {
  const token = LABEL_TOKENS[name] || 'misc';
  return (
    <span className="label" style={{ '--lab': `var(--lab-${token})`, '--lab-bg': `var(--labbg-${token})` }}>
      {name}
    </span>
  );
}

function dueTone(dueDate) {
  if (!dueDate) return null;
  const days = Math.ceil((new Date(dueDate) - Date.now()) / 86_400_000);
  if (days < 0) return 'late';
  if (days === 0) return 'today';
  if (days <= 2) return 'soon';
  return null;
}

export default function CardTile({ card, people, onOpen, disabled }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    data: { type: 'card', card },
    disabled
  });

  const assignee = card.assigneeId ? people[card.assigneeId] : null;
  const tone = dueTone(card.dueDate);

  return (
    <article
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`card ${isDragging ? 'card--dragging' : ''} ${card._pending ? 'card--pending' : ''}`}
      {...attributes}
      {...listeners}
      onDoubleClick={() => onOpen(card)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen(card);
      }}
      tabIndex={0}
      aria-label={card.title}
    >
      {card.labels.length > 0 && (
        <div className="card__labels">
          {card.labels.map((name) => (
            <Label key={name} name={name} />
          ))}
        </div>
      )}

      <p className="card__title">{card.title}</p>

      {card.description && <p className="card__excerpt">{card.description.slice(0, 90)}</p>}

      <div className="card__foot">
        {card.dueDate && (
          <span className={`due ${tone ? `due--${tone}` : ''}`}>
            <Icon name="clock" size={12} />
            {new Date(card.dueDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </span>
        )}
        {assignee && (
          <Avatar userId={card.assigneeId} username={assignee.username} avatar={assignee.avatar} size={22} />
        )}
      </div>
    </article>
  );
}
