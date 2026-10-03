import { useEffect } from 'react';
import Icon from './Icon.jsx';

export default function Toasts({ toasts, onDismiss }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && toasts.at(-1) && onDismiss(toasts.at(-1).id);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toasts, onDismiss]);

  if (!toasts.length) return null;

  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.tone}`}>
          <Icon name={t.tone === 'error' ? 'close' : 'check'} size={14} />
          <span>{t.message}</span>
          <button type="button" className="toast__x" onClick={() => onDismiss(t.id)} aria-label="Dismiss">
            <Icon name="close" size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
