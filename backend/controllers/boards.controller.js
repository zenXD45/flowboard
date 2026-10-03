import mongoose from 'mongoose';
import { Board } from '../models/Board.js';
import { Card } from '../models/Card.js';
import { Comment } from '../models/Comment.js';
import { Activity } from '../models/Activity.js';
import { User } from '../models/User.js';
import config from '../config/index.js';
import { roleFor, canView, publicMember } from '../utils/permissions.js';

export async function listBoards(req, res) {
  const boards = await Board.find({ 'members.userId': req.userId })
    .sort({ updatedAt: -1 })
    .limit(60)
    .lean();

  const boardIds = boards.map((b) => b._id);
  const counts = await Card.aggregate([
    { $match: { boardId: { $in: boardIds } } },
    { $group: { _id: '$boardId', count: { $sum: 1 } } }
  ]);
  const countById = new Map(counts.map((c) => [String(c._id), c.count]));

  const peopleIds = [...new Set(boards.flatMap((b) => b.members.map((m) => String(m.userId))))];
  const people = await User.find({ _id: { $in: peopleIds } }).select('username avatar').lean();
  const peopleById = new Map(people.map((p) => [String(p._id), { username: p.username, avatar: p.avatar || '' }]));

  res.json({
    boards: boards.map((b) => {
      const meta = publicMember(b);
      const me = roleFor(b, req.userId);
      return {
        ...meta,
        role: me,
        cardCount: countById.get(String(b._id)) || 0,
        people: meta.members.map((m) => ({
          userId: m.userId,
          username: peopleById.get(m.userId)?.username || 'unknown',
          avatar: peopleById.get(m.userId)?.avatar || ''
        }))
      };
    })
  });
}

export async function getBoard(req, res) {
  const { boardId } = req.params;
  if (!mongoose.isValidObjectId(boardId)) return res.status(400).json({ error: 'Invalid board id' });

  const board = await Board.findById(boardId).lean();
  if (!board) return res.status(404).json({ error: 'Board not found' });

  const role = roleFor(board, req.userId);
  if (!canView(role)) return res.status(403).json({ error: 'You do not have access to this board' });

  const cards = await Card.find({ boardId }).sort({ listId: 1, position: 1 }).lean();

  // Comments ride along with the snapshot. One extra query for the whole board
  // is far cheaper than a request per card, and it means opening a card shows
  // its full history immediately instead of only what arrived while connected.
  const comments = await Comment.find({ cardId: { $in: cards.map((c) => c._id) } })
    .sort({ createdAt: 1 })
    .lean();

  const peopleIds = [
    ...new Set([String(board.ownerId), ...board.members.map((m) => String(m.userId))])
  ];
  const people = await User.find({ _id: { $in: peopleIds } }).select('username avatar').lean();
  const peopleById = Object.fromEntries(
    people.map((p) => [String(p._id), { username: p.username, avatar: p.avatar || '' }])
  );

  res.json({
    board: publicMember(board),
    role,
    people: peopleById,
    cards: cards.map((c) => ({
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
    })),
    comments: comments.map((c) => ({
      id: String(c._id),
      cardId: String(c.cardId),
      authorId: String(c.authorId),
      authorName: peopleById[String(c.authorId)]?.username || 'unknown',
      body: c.body,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt
    }))
  });
}

export async function getActivity(req, res) {
  const { boardId } = req.params;
  if (!mongoose.isValidObjectId(boardId)) return res.status(400).json({ error: 'Invalid board id' });

  const board = await Board.findById(boardId).select('members ownerId').lean();
  if (!board) return res.status(404).json({ error: 'Board not found' });
  if (!canView(roleFor(board, req.userId))) {
    return res.status(403).json({ error: 'You do not have access to this board' });
  }

  const filter = { boardId };
  const before = req.query.before;
  if (before && mongoose.isValidObjectId(before)) {
    filter._id = { $lt: before };
  }

  const limit = Math.min(
    Math.max(Number(req.query.limit) || config.activityPageSize, 1),
    config.activityPageSize * 2
  );

  const rows = await Activity.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const actorIds = [...new Set(page.map((r) => String(r.actorId)))];
  const actors = await User.find({ _id: { $in: actorIds } }).select('username avatar').lean();
  const actorsById = Object.fromEntries(actors.map((a) => [String(a._id), a.username]));

  res.json({
    activity: page.map((r) => ({
      id: String(r._id),
      actorId: String(r.actorId),
      actorName: actorsById[String(r.actorId)] || 'unknown',
      verb: r.verb,
      targetType: r.targetType,
      targetId: r.targetId,
      meta: r.meta || {},
      createdAt: r.createdAt
    })),
    hasMore,
    nextBefore: hasMore ? String(page[page.length - 1]._id) : null
  });
}
