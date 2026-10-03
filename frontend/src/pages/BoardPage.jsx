import { useAuth } from '../context/AuthContext.jsx';
import { BoardProvider, useBoard } from '../context/BoardContext.jsx';
import Board from '../components/Board.jsx';
import Icon from '../components/Icon.jsx';

function BoardGate({ onExit }) {
  const { loading, fatal, board } = useBoard();
  const { user } = useAuth();

  if (loading) {
    return (
      <div className="board-shell board-shell--center" role="status">
        <span className="boot-ring" aria-hidden="true" />
        <p>Opening the board…</p>
      </div>
    );
  }

  if (fatal) {
    return (
      <div className="board-shell board-shell--center">
        <p className="auth__error">{fatal}</p>
        <button type="button" className="btn" onClick={onExit}>
          <Icon name="back" size={14} /> Back to your boards
        </button>
      </div>
    );
  }

  if (!board) return null;
  return <Board selfId={user?.id} />;
}

export default function BoardPage({ boardId, onExit }) {
  return (
    <BoardProvider boardId={boardId}>
      <BoardGate onExit={onExit} />
    </BoardProvider>
  );
}
