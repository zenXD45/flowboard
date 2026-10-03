import mongoose from 'mongoose';
import config from '../config/index.js';
import { Board } from '../models/Board.js';
import { Card } from '../models/Card.js';
import { Comment } from '../models/Comment.js';
import { User } from '../models/User.js';
import { recordActivity } from '../models/Activity.js';
import { ROLES, roleFor } from '../utils/permissions.js';
import { PROFILE_FIELDS } from '../utils/shape.js';
import { positionBetween, gapIsCollapsed, spacedPositions } from '../utils/position.js';
import {
  cleanString,
  cleanLabels,
  cleanIndex,
  cleanVersion,
  cleanDate,
  isValidObjectId
} from '../utils/validate.js';
import { loadAccess, shapeCard, shapeList, resolvePosition } from './access.js';

const DEFAULT_LISTS = ['To Do', 'In Progress', 'Done'];

/**
 * Which payload fields must be ObjectIds, per event.
 *
 * Enforced centrally in `handle()` rather than inside each handler: fourteen
 * handlers each validating their own ids is fourteen chances to forget one,
 * and a single omission is a query-injection hole that silently deletes or
 * overwrites the wrong record. Anything not listed here is passed through to
 * the handler's own validation.
 */
const ID_FIELDS = {
  'board:update': ['boardId'],
  'board:delete': ['boardId'],
  'member:add': ['boardId'],
  'member:role': ['boardId', 'userId'],
  'member:remove': ['boardId', 'userId'],
  'list:create': ['boardId'],
  'list:rename': ['boardId', 'listId'],
  'list:move': ['boardId', 'listId'],
  'list:delete': ['boardId', 'listId'],
  'card:create': ['boardId', 'listId'],
  'card:move': ['boardId', 'cardId', 'toListId'],
  'card:update': ['boardId', 'cardId'],
  'card:delete': ['boardId', 'cardId'],
  'comment:add': ['boardId', 'cardId']
};

const room = (boardId) => `board:${boardId}`;

function handle(io, socket, event, fn) {
  socket.on(event, async (payload, ack) => {
    const respond = typeof ack === 'function' ? ack : () => {};
    try {
      const data = payload || {};
      for (const field of ID_FIELDS[event] || []) {
        if (!isValidObjectId(data[field])) {
          return respond({ status: 'error', code: 'bad_request', message: `Invalid ${field}` });
        }
      }
      await fn(data, respond, socket);
    } catch (err) {
      if (!config.isTest) console.error(`[ws] ${event} failed:`, err);
      respond({ status: 'error', code: 'server_error', message: 'Something went wrong' });
    }
  });
}

function touch(boardId) {
  return Board.updateOne({ _id: boardId }, { $set: { updatedAt: new Date() } });
}

async function logActivity(entry) {
  const doc = await recordActivity(entry);
  if (!doc) return null;
  return {
    id: String(doc._id),
    actorId: String(doc.actorId),
    // Mirrors the REST shape so a live feed entry and a fetched page render
    // identically. The name comes from the handshake, so this costs no query.
    actorName: entry.actorName || 'unknown',
    verb: doc.verb,
    targetType: doc.targetType,
    targetId: doc.targetId,
    meta: doc.meta || {},
    createdAt: doc.createdAt
  };
}

/** Every mutation resolves the actor once; the activity feed needs the name too. */
function actorName(socket) {
  return socket.data.username || 'unknown';
}

function listIdSet(board) {
  return new Set((board.lists || []).map((l) => String(l._id)));
}

/**
 * Lists are embedded in the board document, so list ordering is computed in
 * memory from the already-loaded array — no extra round trip, and a rename or
 * reorder is a single-document write.
 */
function listPositionBetween(lists, index, excludeId) {
  const others = lists
    .filter((l) => String(l._id) !== String(excludeId))
    .sort((a, b) => a.position - b.position);
  const clamped = Math.min(Math.max(index, 0), others.length);
  const before = clamped > 0 ? others[clamped - 1].position : null;
  const after = clamped < others.length ? others[clamped].position : null;
  return { before, after, clamped, position: positionBetween(before, after), collapsed: gapIsCollapsed(before, after) };
}

export function registerMutations(io, socket) {
  const me = () => socket.data.userId;

  // ---------------------------------------------------------------- board

  handle(io, socket, 'board:create', async (payload, respond) => {
    const title = cleanString(payload.title, 80, { required: true });
    if (title.error) return respond({ status: 'error', code: 'bad_request', message: title.error });
    const description = cleanString(payload.description, 280);
    if (description.error) return respond({ status: 'error', code: 'bad_request', message: description.error });

    const board = await Board.create({
      title: title.value,
      description: description.value,
      ownerId: me(),
      members: [{ userId: me(), role: 'owner' }],
      lists: DEFAULT_LISTS.map((t, i) => ({
        _id: new mongoose.Types.ObjectId(),
        title: t,
        position: (i + 1) * 1024,
        createdAt: new Date()
      }))
    });

    await logActivity({
      boardId: board._id,
      actorId: me(),
      actorName: actorName(socket),
      verb: 'board.created',
      targetType: 'board',
      targetId: String(board._id),
      meta: { title: board.title }
    });

    respond({
      status: 'ok',
      board: {
        id: String(board._id),
        title: board.title,
        description: board.description,
        ownerId: String(board.ownerId),
        members: [{ userId: me(), role: 'owner' }],
        lists: board.lists.map(shapeList),
        createdAt: board.createdAt,
        updatedAt: board.updatedAt
      }
    });
  });

  handle(io, socket, 'board:update', async (payload, respond) => {
    const access = await loadAccess(payload.boardId, me(), { need: 'edit' });
    if (access.error) return respond({ status: 'error', code: access.code, message: access.error });

    const patch = {};
    if (payload.title !== undefined) {
      const t = cleanString(payload.title, 80, { required: true });
      if (t.error) return respond({ status: 'error', code: 'bad_request', message: t.error });
      patch.title = t.value;
    }
    if (payload.description !== undefined) {
      const d = cleanString(payload.description, 280);
      if (d.error) return respond({ status: 'error', code: 'bad_request', message: d.error });
      patch.description = d.value;
    }
    if (Object.keys(patch).length === 0) {
      return respond({ status: 'error', code: 'bad_request', message: 'Nothing to update' });
    }

    patch.updatedAt = new Date();
    const board = await Board.findByIdAndUpdate(access.board._id, { $set: patch }, { new: true }).lean();

    io.to(room(board._id)).emit('board:updated', {
      boardId: String(board._id),
      patch: { title: board.title, description: board.description, updatedAt: board.updatedAt }
    });

    const activity = await logActivity({
      boardId: board._id,
      actorId: me(),
      actorName: actorName(socket),
      verb: 'board.updated',
      targetType: 'board',
      targetId: String(board._id),
      meta: { title: board.title }
    });
    if (activity) io.to(room(board._id)).emit('activity:new', activity);

    respond({ status: 'ok', patch: { title: board.title, description: board.description } });
  });

  handle(io, socket, 'board:delete', async (payload, respond) => {
    const access = await loadAccess(payload.boardId, me(), { need: 'manage' });
    if (access.error) return respond({ status: 'error', code: access.code, message: access.error });

    await Promise.all([
      Card.deleteMany({ boardId: access.board._id }),
      Comment.deleteMany({ boardId: access.board._id }),
      Board.deleteOne({ _id: access.board._id })
    ]);
    io.to(room(access.board._id)).emit('board:deleted', { boardId: String(access.board._id) });
    respond({ status: 'ok' });
  });

  // -------------------------------------------------------------- members

  handle(io, socket, 'member:add', async (payload, respond) => {
    const access = await loadAccess(payload.boardId, me(), { need: 'manage' });
    if (access.error) return respond({ status: 'error', code: access.code, message: access.error });

    const username = cleanString(payload.username, 24, { required: true });
    if (username.error) return respond({ status: 'error', code: 'bad_request', message: username.error });
    const role = ROLES.filter((r) => r !== 'owner').includes(payload.role) ? payload.role : 'member';

    const invitee = await User.findOne({ username: username.value.toLowerCase() }).select(PROFILE_FIELDS).lean();
    if (!invitee) return respond({ status: 'error', code: 'not_found', message: `No user named "${username.value}"` });
    if (roleFor(access.board, invitee._id)) {
      return respond({ status: 'error', code: 'conflict', message: 'That person is already on the board' });
    }

    const addedAt = new Date();
    await Board.updateOne(
      { _id: access.board._id },
      { $push: { members: { userId: invitee._id, role, addedAt } }, $set: { updatedAt: addedAt } }
    );

    const member = {
      userId: String(invitee._id),
      username: invitee.username,
      displayName: invitee.displayName || '',
      avatar: invitee.avatar || '',
      avatarColor: invitee.avatarColor || '',
      role,
      addedAt
    };
    io.to(room(access.board._id)).emit('member:added', { boardId: String(access.board._id), member });

    const activity = await logActivity({
      boardId: access.board._id,
      actorId: me(),
      actorName: actorName(socket),
      verb: 'member.added',
      targetType: 'board',
      targetId: String(invitee._id),
      meta: { username: invitee.username, role }
    });
    if (activity) io.to(room(access.board._id)).emit('activity:new', activity);

    respond({ status: 'ok', member });
  });

  handle(io, socket, 'member:role', async (payload, respond) => {
    const access = await loadAccess(payload.boardId, me(), { need: 'manage' });
    if (access.error) return respond({ status: 'error', code: access.code, message: access.error });

    // Ownership is carried by Board.ownerId, not by a role in the members array.
    // Allowing a second 'owner' here would produce two users with manage rights
    // while only one of them is the recorded owner — ambiguity in who may delete
    // the board, and a way to strand the real owner.
    const ASSIGNABLE = ['member', 'viewer'];
    if (!ASSIGNABLE.includes(payload.role)) {
      return respond({
        status: 'error',
        code: 'bad_request',
        message: 'Role must be member or viewer; ownership transfers are not supported'
      });
    }
    if (String(payload.userId) === String(me())) {
      return respond({ status: 'error', code: 'forbidden', message: 'You cannot change your own role' });
    }

    const subject = (access.board.members || []).find((m) => String(m.userId) === String(payload.userId));
    const result = await Board.updateOne(
      { _id: access.board._id, 'members.userId': payload.userId },
      { $set: { 'members.$.role': payload.role } }
    );
    if (result.matchedCount === 0) {
      return respond({ status: 'error', code: 'not_found', message: 'That person is not on this board' });
    }

    io.to(room(access.board._id)).emit('member:role', {
      boardId: String(access.board._id),
      userId: String(payload.userId),
      role: payload.role
    });

    const roleActivity = await logActivity({
      boardId: access.board._id,
      actorId: me(),
      actorName: actorName(socket),
      verb: 'member.role',
      targetType: 'user',
      targetId: String(payload.userId),
      meta: { username: subject?.username, role: payload.role }
    });
    if (roleActivity) io.to(room(access.board._id)).emit('activity:new', roleActivity);

    respond({ status: 'ok' });
  });

  handle(io, socket, 'member:remove', async (payload, respond) => {
    const access = await loadAccess(payload.boardId, me(), { need: 'manage' });
    if (access.error) return respond({ status: 'error', code: access.code, message: access.error });

    if (String(payload.userId) === String(me())) {
      return respond({ status: 'error', code: 'forbidden', message: 'Owners cannot remove themselves' });
    }

    const target = (access.board.members || []).find((m) => String(m.userId) === String(payload.userId));
    if (!target) return respond({ status: 'error', code: 'not_found', message: 'That person is not on this board' });

    await Board.updateOne({ _id: access.board._id }, { $pull: { members: { userId: payload.userId } } });
    io.to(room(access.board._id)).emit('member:removed', {
      boardId: String(access.board._id),
      userId: String(payload.userId)
    });

    const removeActivity = await logActivity({
      boardId: access.board._id,
      actorId: me(),
      actorName: actorName(socket),
      verb: 'member.removed',
      targetType: 'user',
      targetId: String(payload.userId),
      meta: { username: target.username }
    });
    if (removeActivity) io.to(room(access.board._id)).emit('activity:new', removeActivity);

    respond({ status: 'ok' });
  });

  // ---------------------------------------------------------------- lists

  handle(io, socket, 'list:create', async (payload, respond) => {
    const access = await loadAccess(payload.boardId, me(), { need: 'edit' });
    if (access.error) return respond({ status: 'error', code: access.code, message: access.error });

    const title = cleanString(payload.title, 60, { required: true });
    if (title.error) return respond({ status: 'error', code: 'bad_request', message: title.error });
    const idx = cleanIndex(payload.index, (access.board.lists || []).length);
    if (idx.error) return respond({ status: 'error', code: 'bad_request', message: idx.error });

    if ((access.board.lists || []).length >= config.maxListsPerBoard) {
      return respond({ status: 'error', code: 'limit', message: `A board can hold at most ${config.maxListsPerBoard} lists` });
    }

    const { position } = listPositionBetween(access.board.lists || [], idx.value, null);
    const listId = new mongoose.Types.ObjectId();
    const list = { _id: listId, title: title.value, position, createdAt: new Date() };
    const updatedAt = new Date();

    await Board.updateOne(
      { _id: access.board._id },
      { $push: { lists: list }, $set: { updatedAt } }
    );

    io.to(room(access.board._id)).emit('list:created', {
      boardId: String(access.board._id),
      list: shapeList(list)
    });

    const activity = await logActivity({
      boardId: access.board._id,
      actorId: me(),
      actorName: actorName(socket),
      verb: 'list.created',
      targetType: 'list',
      targetId: String(listId),
      meta: { title: title.value }
    });
    if (activity) io.to(room(access.board._id)).emit('activity:new', activity);

    respond({ status: 'ok', list: shapeList(list) });
  });

  handle(io, socket, 'list:rename', async (payload, respond) => {
    const access = await loadAccess(payload.boardId, me(), { need: 'edit' });
    if (access.error) return respond({ status: 'error', code: access.code, message: access.error });

    const title = cleanString(payload.title, 60, { required: true });
    if (title.error) return respond({ status: 'error', code: 'bad_request', message: title.error });
    if (!listIdSet(access.board).has(String(payload.listId))) {
      return respond({ status: 'error', code: 'not_found', message: 'That list no longer exists' });
    }

    const updatedAt = new Date();
    await Board.updateOne(
      { _id: access.board._id, 'lists._id': payload.listId },
      { $set: { 'lists.$.title': title.value, updatedAt } }
    );

    io.to(room(access.board._id)).emit('list:renamed', {
      boardId: String(access.board._id),
      listId: String(payload.listId),
      title: title.value
    });

    const activity = await logActivity({
      boardId: access.board._id,
      actorId: me(),
      actorName: actorName(socket),
      verb: 'list.renamed',
      targetType: 'list',
      targetId: String(payload.listId),
      meta: { title: title.value }
    });
    if (activity) io.to(room(access.board._id)).emit('activity:new', activity);

    respond({ status: 'ok', title: title.value });
  });

  handle(io, socket, 'list:move', async (payload, respond) => {
    const access = await loadAccess(payload.boardId, me(), { need: 'edit' });
    if (access.error) return respond({ status: 'error', code: access.code, message: access.error });

    const idx = cleanIndex(payload.index);
    if (idx.error) return respond({ status: 'error', code: 'bad_request', message: idx.error });
    if (!listIdSet(access.board).has(String(payload.listId))) {
      return respond({ status: 'error', code: 'not_found', message: 'That list no longer exists' });
    }

    const current = (access.board.lists || []).find((l) => String(l._id) === String(payload.listId));
    const computed = listPositionBetween(access.board.lists || [], idx.value, payload.listId);
    const updatedAt = new Date();

    if (computed.collapsed) {
      const others = (access.board.lists || [])
        .filter((l) => String(l._id) !== String(payload.listId))
        .sort((a, b) => a.position - b.position);
      const positions = spacedPositions(others.length + 1);
      const rebuilt = others.map((l, i) => ({ _id: l._id, title: l.title, position: positions[i], createdAt: l.createdAt }));
      rebuilt.splice(computed.clamped, 0, {
        _id: current._id,
        title: current.title,
        position: positions[computed.clamped],
        createdAt: current.createdAt
      });
      await Board.updateOne({ _id: access.board._id }, { $set: { lists: rebuilt, updatedAt } });
    } else {
      await Board.updateOne(
        { _id: access.board._id, 'lists._id': payload.listId },
        { $set: { 'lists.$.position': computed.position, updatedAt } }
      );
    }

    io.to(room(access.board._id)).emit('list:moved', {
      boardId: String(access.board._id),
      listId: String(payload.listId),
      position: computed.position
    });

    const activity = await logActivity({
      boardId: access.board._id,
      actorId: me(),
      actorName: actorName(socket),
      verb: 'list.moved',
      targetType: 'list',
      targetId: String(payload.listId),
      meta: { title: current.title }
    });
    if (activity) io.to(room(access.board._id)).emit('activity:new', activity);

    respond({ status: 'ok', position: computed.position });
  });

  handle(io, socket, 'list:delete', async (payload, respond) => {
    const access = await loadAccess(payload.boardId, me(), { need: 'edit' });
    if (access.error) return respond({ status: 'error', code: access.code, message: access.error });
    if (!listIdSet(access.board).has(String(payload.listId))) {
      return respond({ status: 'error', code: 'not_found', message: 'That list no longer exists' });
    }
    if ((access.board.lists || []).length <= 1) {
      return respond({ status: 'error', code: 'limit', message: 'A board needs at least one list' });
    }

    const doomed = await Card.find({ boardId: access.board._id, listId: payload.listId }).select('_id').lean();
    const updatedAt = new Date();
    await Board.updateOne({ _id: access.board._id }, { $pull: { lists: { _id: payload.listId } }, $set: { updatedAt } });
    await Card.deleteMany({ boardId: access.board._id, listId: payload.listId });

    io.to(room(access.board._id)).emit('list:deleted', {
      boardId: String(access.board._id),
      listId: String(payload.listId),
      removedCardIds: doomed.map((c) => String(c._id))
    });

    const activity = await logActivity({
      boardId: access.board._id,
      actorId: me(),
      actorName: actorName(socket),
      verb: 'list.deleted',
      targetType: 'list',
      targetId: String(payload.listId),
      meta: {}
    });
    if (activity) io.to(room(access.board._id)).emit('activity:new', activity);

    respond({ status: 'ok', removedCardIds: doomed.map((c) => String(c._id)) });
  });

  // ---------------------------------------------------------------- cards

  handle(io, socket, 'card:create', async (payload, respond) => {
    const access = await loadAccess(payload.boardId, me(), { need: 'edit' });
    if (access.error) return respond({ status: 'error', code: access.code, message: access.error });

    const title = cleanString(payload.title, 140, { required: true });
    if (title.error) return respond({ status: 'error', code: 'bad_request', message: title.error });
    if (!listIdSet(access.board).has(String(payload.listId))) {
      return respond({ status: 'error', code: 'not_found', message: 'That list no longer exists' });
    }

    const count = await Card.countDocuments({ boardId: access.board._id, listId: payload.listId });
    if (count >= config.maxCardsPerList) {
      return respond({ status: 'error', code: 'limit', message: `A list can hold at most ${config.maxCardsPerList} cards` });
    }

    const { position } = await resolvePosition(access.board._id, payload.listId, payload.index ?? count, null);
    const card = await Card.create({
      boardId: access.board._id,
      listId: payload.listId,
      title: title.value,
      position,
      createdBy: me(),
      version: 1
    });

    io.to(room(access.board._id)).emit('card:created', {
      boardId: String(access.board._id),
      card: shapeCard(card)
    });

    const activity = await logActivity({
      boardId: access.board._id,
      actorId: me(),
      actorName: actorName(socket),
      verb: 'card.created',
      targetType: 'card',
      targetId: String(card._id),
      meta: { title: card.title }
    });
    if (activity) io.to(room(access.board._id)).emit('activity:new', activity);

    respond({ status: 'ok', card: shapeCard(card) });
  });

  handle(io, socket, 'card:move', async (payload, respond) => {
    const access = await loadAccess(payload.boardId, me(), { need: 'edit' });
    if (access.error) return respond({ status: 'error', code: access.code, message: access.error });

    const version = cleanVersion(payload.expectedVersion);
    if (version.error) return respond({ status: 'error', code: 'bad_request', message: version.error });
    const idx = cleanIndex(payload.index, 0);
    if (idx.error) return respond({ status: 'error', code: 'bad_request', message: idx.error });
    if (!listIdSet(access.board).has(String(payload.toListId))) {
      return respond({ status: 'error', code: 'not_found', message: 'That list no longer exists' });
    }

    const existing = await Card.findOne({ _id: payload.cardId, boardId: access.board._id }).lean();
    if (!existing) return respond({ status: 'error', code: 'not_found', message: 'That card no longer exists' });

    const { position } = await resolvePosition(access.board._id, payload.toListId, idx.value, payload.cardId);
    const updatedAt = new Date();

    // Single-document atomic compare-and-set. MongoDB guarantees this find-and-set
    // cannot interleave with another writer on the same document, so the version
    // guard turns "two people dropped this card at once" into a decided outcome
    // rather than a lost update.
    const result = await Card.updateOne(
      { _id: payload.cardId, boardId: access.board._id, version: version.value },
      { $set: { listId: payload.toListId, position, updatedAt }, $inc: { version: 1 } }
    );

    if (result.matchedCount === 0) {
      const current = await Card.findById(payload.cardId).lean();
      if (!current) return respond({ status: 'error', code: 'not_found', message: 'That card no longer exists' });
      return respond({
        status: 'conflict',
        message: 'Someone else changed this card first',
        card: shapeCard(current)
      });
    }

    const card = await Card.findById(payload.cardId).lean();
    const crossedLists = String(existing.listId) !== String(payload.toListId);

    io.to(room(access.board._id)).emit('card:moved', {
      boardId: String(access.board._id),
      card: shapeCard(card)
    });

    if (crossedLists) {
      const activity = await logActivity({
        boardId: access.board._id,
        actorId: me(),
        actorName: actorName(socket),
        verb: 'card.moved',
        targetType: 'card',
        targetId: String(card._id),
        meta: { title: card.title }
      });
      if (activity) io.to(room(access.board._id)).emit('activity:new', activity);
    }

    respond({ status: 'ok', card: shapeCard(card) });
  });

  handle(io, socket, 'card:update', async (payload, respond) => {
    const access = await loadAccess(payload.boardId, me(), { need: 'edit' });
    if (access.error) return respond({ status: 'error', code: access.code, message: access.error });

    const version = cleanVersion(payload.expectedVersion);
    if (version.error) return respond({ status: 'error', code: 'bad_request', message: version.error });

    // An explicit allowlist, not a spread. Without it a client could smuggle
    // version/boardId/createdBy straight into $set and defeat the version guard
    // or rewrite ownership by sending a patch instead of a move.
    const patch = payload.patch;
    if (patch === undefined || patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      return respond({ status: 'error', code: 'bad_request', message: 'patch must be an object' });
    }
    const ALLOWED = new Set(['title', 'description', 'labels', 'dueDate', 'assigneeId']);
    const rejected = Object.keys(patch).filter((k) => !ALLOWED.has(k));
    if (rejected.length > 0) {
      return respond({
        status: 'error',
        code: 'bad_request',
        message: `patch contains unsupported field(s): ${rejected.join(', ')}`
      });
    }

    const $set = {};
    if (patch.title !== undefined) {
      const t = cleanString(patch.title, 140, { required: true });
      if (t.error) return respond({ status: 'error', code: 'bad_request', message: t.error });
      $set.title = t.value;
    }
    if (patch.description !== undefined) {
      const d = cleanString(patch.description, 4000);
      if (d.error) return respond({ status: 'error', code: 'bad_request', message: d.error });
      $set.description = d.value;
    }
    if (patch.labels !== undefined) {
      const l = cleanLabels(patch.labels);
      if (l.error) return respond({ status: 'error', code: 'bad_request', message: l.error });
      $set.labels = l.value;
    }
    if (patch.dueDate !== undefined) {
      const d = cleanDate(patch.dueDate);
      if (d.error) return respond({ status: 'error', code: 'bad_request', message: d.error });
      $set.dueDate = d.value;
    }
    if (patch.assigneeId !== undefined) {
      if (patch.assigneeId === null || patch.assigneeId === '') {
        $set.assigneeId = null;
      } else {
        const memberIds = new Set((access.board.members || []).map((m) => String(m.userId)));
        memberIds.add(String(access.board.ownerId));
        if (!memberIds.has(String(patch.assigneeId))) {
          return respond({ status: 'error', code: 'bad_request', message: 'Assignee must be a board member' });
        }
        $set.assigneeId = patch.assigneeId;
      }
    }

    if (Object.keys($set).length === 0) {
      return respond({ status: 'error', code: 'bad_request', message: 'Nothing to update' });
    }

    const updatedAt = new Date();
    const result = await Card.updateOne(
      { _id: payload.cardId, boardId: access.board._id, version: version.value },
      { $set: { ...$set, updatedAt }, $inc: { version: 1 } }
    );

    if (result.matchedCount === 0) {
      const current = await Card.findById(payload.cardId).lean();
      if (!current) return respond({ status: 'error', code: 'not_found', message: 'That card no longer exists' });
      return respond({
        status: 'conflict',
        message: 'Someone else changed this card first',
        card: shapeCard(current)
      });
    }

    const card = await Card.findById(payload.cardId).lean();
    io.to(room(access.board._id)).emit('card:updated', {
      boardId: String(access.board._id),
      card: shapeCard(card)
    });

    const wasAssigned = Object.prototype.hasOwnProperty.call($set, 'assigneeId');
    const activity = await logActivity({
      boardId: access.board._id,
      actorId: me(),
      actorName: actorName(socket),
      verb: wasAssigned ? 'card.assigned' : 'card.updated',
      targetType: 'card',
      targetId: String(card._id),
      meta: { title: card.title }
    });
    if (activity) io.to(room(access.board._id)).emit('activity:new', activity);

    respond({ status: 'ok', card: shapeCard(card) });
  });

  handle(io, socket, 'card:delete', async (payload, respond) => {
    const access = await loadAccess(payload.boardId, me(), { need: 'edit' });
    if (access.error) return respond({ status: 'error', code: access.code, message: access.error });

    const card = await Card.findOneAndDelete({ _id: payload.cardId, boardId: access.board._id }).lean();
    if (!card) return respond({ status: 'error', code: 'not_found', message: 'That card no longer exists' });

    await Comment.deleteMany({ cardId: card._id });
    io.to(room(access.board._id)).emit('card:deleted', {
      boardId: String(access.board._id),
      cardId: String(card._id)
    });

    const activity = await logActivity({
      boardId: access.board._id,
      actorId: me(),
      actorName: actorName(socket),
      verb: 'card.deleted',
      targetType: 'card',
      targetId: String(card._id),
      meta: { title: card.title }
    });
    if (activity) io.to(room(access.board._id)).emit('activity:new', activity);

    respond({ status: 'ok' });
  });

  // ------------------------------------------------------------- comments

  handle(io, socket, 'comment:add', async (payload, respond) => {
    const access = await loadAccess(payload.boardId, me(), { need: 'edit' });
    if (access.error) return respond({ status: 'error', code: access.code, message: access.error });

    const body = cleanString(payload.body, 2000, { required: true });
    if (body.error) return respond({ status: 'error', code: 'bad_request', message: body.error });

    const card = await Card.findOne({ _id: payload.cardId, boardId: access.board._id }).select('_id title').lean();
    if (!card) return respond({ status: 'error', code: 'not_found', message: 'That card no longer exists' });

    const comment = await Comment.create({
      boardId: access.board._id,
      cardId: card._id,
      authorId: me(),
      body: body.value
    });

    io.to(room(access.board._id)).emit('comment:new', {
      boardId: String(access.board._id),
      cardId: String(card._id),
      comment: {
        id: String(comment._id),
        cardId: String(comment.cardId),
        authorId: String(comment.authorId),
        authorName: actorName(socket),
        body: comment.body,
        createdAt: comment.createdAt
      }
    });

    const activity = await logActivity({
      boardId: access.board._id,
      actorId: me(),
      actorName: actorName(socket),
      verb: 'comment.added',
      targetType: 'card',
      targetId: String(card._id),
      meta: { title: card.title }
    });
    if (activity) io.to(room(access.board._id)).emit('activity:new', activity);

    respond({ status: 'ok', comment: { id: String(comment._id) } });
  });
}
