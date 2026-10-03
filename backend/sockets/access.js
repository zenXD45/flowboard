import mongoose from 'mongoose';
import { Board } from '../models/Board.js';
import { Card } from '../models/Card.js';
import config from '../config/index.js';
import { recordActivity } from '../models/Activity.js';
import { canEdit, canManage, roleFor } from '../utils/permissions.js';
import { positionBetween, gapIsCollapsed, spacedPositions, POSITION_GAP } from '../utils/position.js';
import { cleanString, cleanLabels, cleanIndex, cleanVersion, cleanDate } from '../utils/validate.js';

/**
 * Authorization is re-read from the database on every mutation rather than cached
 * on the socket. This costs one small projection read per write, and buys us the
 * guarantee that a revoked member cannot act on a stale role for the life of
 * their connection. See DESIGN.md -> "Authorization vs authentication".
 */
export async function loadAccess(boardId, userId, { need = 'view' } = {}) {
  if (!mongoose.isValidObjectId(boardId)) {
    return { error: 'Invalid board id', code: 'bad_request', status: 400 };
  }
  let board;
  try {
    board = await Board.findById(boardId).select('ownerId members lists title').lean();
  } catch {
    return { error: 'Invalid board id', code: 'bad_request', status: 400 };
  }
  if (!board) return { error: 'Board not found', code: 'not_found', status: 404 };

  const role = roleFor(board, userId);
  if (!role) return { error: 'You do not have access to this board', code: 'forbidden', status: 403 };
  if (need === 'edit' && !canEdit(role)) {
    return { error: 'Viewers cannot change this board', code: 'forbidden', status: 403 };
  }
  if (need === 'manage' && !canManage(role)) {
    return { error: 'Only the board owner can do that', code: 'forbidden', status: 403 };
  }
  return { board, role };
}

export function shapeCard(card) {
  const c = card.toObject ? card.toObject() : card;
  return {
    id: String(c._id),
    listId: String(c.listId),
    title: c.title,
    description: c.description || '',
    position: c.position,
    assigneeId: c.assigneeId ? String(c.assigneeId) : null,
    dueDate: c.dueDate || null,
    labels: c.labels || [],
    version: c.version,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt
  };
}

export function shapeList(list) {
  return {
    id: String(list._id),
    title: list.title,
    position: list.position,
    createdAt: list.createdAt
  };
}

/**
 * Translates a client-supplied visual index into a fractional position by
 * reading the target list's neighbours. Clients send intent ("drop at index 2"),
 * never geometry, so the server stays the only authority on ordering maths.
 */
export async function resolvePosition(boardId, listId, index, excludeCardId = null) {
  const filter = { boardId, listId };
  if (excludeCardId && mongoose.isValidObjectId(excludeCardId)) {
    filter._id = { $ne: new mongoose.Types.ObjectId(excludeCardId) };
  }

  let siblings = await Card.find(filter).sort({ position: 1 }).select('position').lean();
  const clamped = Math.min(Math.max(index, 0), siblings.length);
  const before = clamped > 0 ? siblings[clamped - 1].position : null;
  const after = clamped < siblings.length ? siblings[clamped].position : null;

  if (gapIsCollapsed(before, after)) {
    await normaliseList(boardId, listId, excludeCardId);
    siblings = await Card.find(filter).sort({ position: 1 }).select('position').lean();
    const safe = Math.min(Math.max(index, 0), siblings.length);
    return {
      position: positionBetween(
        safe > 0 ? siblings[safe - 1].position : null,
        safe < siblings.length ? siblings[safe].position : null
      ),
      normalised: true
    };
  }

  return { position: positionBetween(before, after), normalised: false };
}

/**
 * Fractional positions bleed toward zero after many repeated insertions at the
 * same spot. When the gap between neighbours falls below MIN_GAP we rewrite the
 * whole list back to even 1024-spaced slots. This is a multi-document write and
 * is therefore not atomic — see DESIGN.md -> "Why normalisation is not atomic".
 */
async function normaliseList(boardId, listId, excludeCardId = null) {
  const filter = { boardId, listId };
  if (excludeCardId && mongoose.isValidObjectId(excludeCardId)) {
    filter._id = { $ne: new mongoose.Types.ObjectId(excludeCardId) };
  }
  const cards = await Card.find(filter).sort({ position: 1 }).select('_id').lean();
  if (cards.length === 0) return;
  const positions = spacedPositions(cards.length);
  await Card.bulkWrite(
    cards.map((c, i) => ({
      updateOne: {
        filter: { _id: c._id, version: { $lte: Number.MAX_SAFE_INTEGER } },
        update: { $set: { position: positions[i] } }
      }
    }))
  );
}

export function listPositionPayload(board) {
  return (board.lists || [])
    .slice()
    .sort((a, b) => a.position - b.position)
    .map(shapeList);
}

export function limits() {
  return { maxLists: config.maxListsPerBoard, gap: POSITION_GAP };
}

export { recordActivity, canEdit, canManage, cleanString, cleanLabels, cleanIndex, cleanVersion, cleanDate };
