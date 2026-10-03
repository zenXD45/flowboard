import { useAuth } from '../context/AuthContext.jsx';
import { BoardProvider, useBoard } from '../context/BoardContext.jsx';
import Board from '../components/Board.jsx';
import Icon from '../components/Icon.jsx';

/**
 * A skeleton shaped like the board it replaces.
 *
 * The spinner said "something is happening"; this says "a board with three
 * columns and some cards is arriving", which is the information a waiting user
 * actually wants. Shapes match the real layout so nothing jumps when the data
 * lands — the columns are the same width, the cards the same height.
 */
function BoardSkeleton() {
  return (
    <div className="board-shell board-shell--center" role="status" aria-label="Opening the board">
      <div className="skel">
        <div className="skel__col">
          <span className="skel__bar" />
          <span className="skel__card" />
          <span className="skel__card" />
          <span className="skel__card skel__card--short" />
        </div>
        <div className="skel__col">
          <span className="skel__bar" />
          <span className="skel__card" />
          <span className="skel__card" />
        </div>
        <div className="skel__col">
          <span className="skel__bar" />
          <span className="skel__card" />
        </div>
      </div>
      <span className="skel__note">Opening the board…</span>
    </div>
  );
}

function BoardGate({ onExit }) {
  const { loading, fatal, board } = useBoard();
  const { user } = useAuth();

  if (loading) return <BoardSkeleton />;

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
