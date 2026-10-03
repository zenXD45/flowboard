import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer,
  stopTestServer,
  resetDatabase,
  makeUser,
  request,
  connect,
  emit,
  makeBoard
} from './helpers.js';

before(async () => {
  await startTestServer();
});
after(async () => {
  await stopTestServer();
});
beforeEach(async () => {
  await resetDatabase();
});

const sockets = [];
async function open(token) {
  const socket = await connect(token);
  sockets.push(socket);
  return socket;
}
after(() => {
  for (const s of sockets) s.close();
});

/**
 * Builds: an owner, a plain member, a viewer and an outsider — all on one board.
 */
async function crew() {
  const owner = await makeUser('own');
  const member = await makeUser('mem');
  const viewer = await makeUser('view');
  const outsider = await makeUser('out');

  const board = await makeBoard(owner.token, 'Secured Board');
  const ownerSocket = await open(owner.token);
  await emit(ownerSocket, 'board:join', { boardId: board.id });
  await emit(ownerSocket, 'member:add', { boardId: board.id, username: member.username, role: 'member' });
  await emit(ownerSocket, 'member:add', { boardId: board.id, username: viewer.username, role: 'viewer' });

  const memberSocket = await open(member.token);
  const viewerSocket = await open(viewer.token);
  const outsiderSocket = await open(outsider.token);
  for (const s of [memberSocket, viewerSocket]) {
    await emit(s, 'board:join', { boardId: board.id });
  }

  return { owner, member, viewer, outsider, board, ownerSocket, memberSocket, viewerSocket, outsiderSocket };
}

test('a viewer may read but not write', async () => {
  const { viewer, board, viewerSocket } = await crew();
  const listId = board.lists[0].id;

  const created = await emit(viewerSocket, 'card:create', { boardId: board.id, listId, title: 'Nope' });
  assert.equal(created.status, 'error');
  assert.equal(created.code, 'forbidden');

  const listed = await emit(viewerSocket, 'list:create', { boardId: board.id, title: 'Nope' });
  assert.equal(listed.code, 'forbidden');

  const renamed = await emit(viewerSocket, 'board:update', { boardId: board.id, title: 'Hijacked' });
  assert.equal(renamed.code, 'forbidden');

  const read = await request('GET', `/api/boards/${board.id}`, { token: viewer.token });
  assert.equal(read.status, 200);
});

test('an outsider cannot join, write, or read the board', async () => {
  const { board, outsiderSocket, outsider } = await crew();

  const join = await emit(outsiderSocket, 'board:join', { boardId: board.id });
  assert.equal(join.code, 'forbidden');

  const write = await emit(outsiderSocket, 'card:create', {
    boardId: board.id,
    listId: board.lists[0].id,
    title: 'Trespass'
  });
  assert.equal(write.code, 'forbidden');

  const read = await request('GET', `/api/boards/${board.id}`, { token: outsider.token });
  assert.equal(read.status, 403);
});

test('a plain member cannot manage members', async () => {
  const { member, board, memberSocket } = await crew();

  const add = await emit(memberSocket, 'member:add', {
    boardId: board.id,
    username: member.username,
    role: 'member'
  });
  assert.equal(add.code, 'forbidden');

  const promote = await emit(memberSocket, 'member:role', {
    boardId: board.id,
    userId: member.id,
    role: 'owner'
  });
  assert.equal(promote.code, 'forbidden');
});

test('a member cannot escalate their own role', async () => {
  const { member, board, memberSocket } = await crew();
  const ack = await emit(memberSocket, 'member:role', { boardId: board.id, userId: member.id, role: 'owner' });
  assert.equal(ack.code, 'forbidden');

  const { Board } = await import('../models/Board.js');
  const stored = await Board.findById(board.id).lean();
  const entry = stored.members.find((m) => String(m.userId) === member.id);
  assert.equal(entry.role, 'member');
});

test('the owner cannot promote anyone to owner or demote themselves', async () => {
  const { owner, member, board, ownerSocket } = await crew();

  const toOwner = await emit(ownerSocket, 'member:role', { boardId: board.id, userId: member.id, role: 'owner' });
  assert.equal(toOwner.code, 'bad_request');

  const self = await emit(ownerSocket, 'member:role', { boardId: board.id, userId: owner.id, role: 'viewer' });
  assert.equal(self.code, 'forbidden');

  const leave = await emit(ownerSocket, 'member:remove', { boardId: board.id, userId: owner.id });
  assert.equal(leave.code, 'forbidden');
});

test('only the owner can delete a board', async () => {
  const { board, memberSocket, ownerSocket } = await crew();

  const byMember = await emit(memberSocket, 'board:delete', { boardId: board.id });
  assert.equal(byMember.code, 'forbidden');

  const byOwner = await emit(ownerSocket, 'board:delete', { boardId: board.id });
  assert.equal(byOwner.status, 'ok');
});

test('a removed member loses write access immediately', async () => {
  const { member, board, ownerSocket, memberSocket } = await crew();
  const listId = board.lists[0].id;

  const before = await emit(memberSocket, 'card:create', { boardId: board.id, listId, title: 'Allowed' });
  assert.equal(before.status, 'ok');

  await emit(ownerSocket, 'member:remove', { boardId: board.id, userId: member.id });

  const after = await emit(memberSocket, 'card:create', { boardId: board.id, listId, title: 'Denied' });
  assert.equal(after.status, 'error');
  assert.equal(after.code, 'forbidden');
});

test('card:update refuses fields outside the allowlist', async () => {
  const { board, ownerSocket, owner } = await crew();
  const card = await emit(ownerSocket, 'card:create', {
    boardId: board.id,
    listId: board.lists[0].id,
    title: 'Guarded'
  });

  for (const patch of [{ version: 99 }, { boardId: '64b000000000000000000000' }, { _id: 'x' }, { createdBy: 'x' }]) {
    const ack = await emit(ownerSocket, 'card:update', {
      boardId: board.id,
      cardId: card.card.id,
      patch,
      expectedVersion: card.card.version
    });
    assert.equal(ack.status, 'error', `patch ${JSON.stringify(patch)} should be rejected`);
    assert.equal(ack.code, 'bad_request');
  }

  const still = await emit(ownerSocket, 'card:move', {
    boardId: board.id,
    cardId: card.card.id,
    toListId: board.lists[0].id,
    index: 0,
    expectedVersion: card.card.version
  });
  assert.equal(still.status, 'ok', 'the rejected patches must not have touched the card');
  assert.equal(still.card.version, 2);
  assert.ok(owner.id);
});

test('a card cannot be assigned to someone who is not on the board', async () => {
  const { board, ownerSocket, outsider } = await crew();
  const card = await emit(ownerSocket, 'card:create', {
    boardId: board.id,
    listId: board.lists[0].id,
    title: 'Assignee test'
  });

  const ack = await emit(ownerSocket, 'card:update', {
    boardId: board.id,
    cardId: card.card.id,
    patch: { assigneeId: outsider.id },
    expectedVersion: card.card.version
  });
  assert.equal(ack.status, 'error');
  assert.equal(ack.code, 'bad_request');
});

test('strips and rejects labels that could not be rendered safely', async () => {
  const { board, ownerSocket } = await crew();
  const card = await emit(ownerSocket, 'card:create', {
    boardId: board.id,
    listId: board.lists[0].id,
    title: 'Labels'
  });

  const ok = await emit(ownerSocket, 'card:update', {
    boardId: board.id,
    cardId: card.card.id,
    patch: { labels: [' Bug ', 'bug', 'P1'] },
    expectedVersion: card.card.version
  });
  assert.equal(ok.status, 'ok');
  assert.deepEqual(ok.card.labels, ['bug', 'p1'], 'labels normalise and de-duplicate');

  const bad = await emit(ownerSocket, 'card:update', {
    boardId: board.id,
    cardId: card.card.id,
    patch: { labels: ['<script>alert(1)</script>'] },
    expectedVersion: ok.card.version
  });
  assert.equal(bad.status, 'error');
  assert.equal(bad.code, 'bad_request');
});

test('a script-like card title is stored as inert text, never as markup', async () => {
  const { board, ownerSocket } = await crew();
  const payload = '<img src=x onerror="alert(1)">';

  const card = await emit(ownerSocket, 'card:create', {
    boardId: board.id,
    listId: board.lists[0].id,
    title: payload
  });
  assert.equal(card.status, 'ok');
  assert.equal(card.card.title, payload, 'stored verbatim; the UI renders it as a text node');

  const res = await request('GET', `/api/boards/${board.id}`, { token: null });
  assert.ok([401, 403].includes(res.status));
});

test('a member cannot add themselves twice or rename the board owner field', async () => {
  const { member, board, ownerSocket } = await crew();

  const dupe = await emit(ownerSocket, 'member:add', {
    boardId: board.id,
    username: member.username,
    role: 'member'
  });
  assert.equal(dupe.code, 'conflict');

  const rename = await emit(ownerSocket, 'board:update', { boardId: board.id, ownerId: member.id });
  assert.equal(rename.code, 'bad_request');
});

test('the owner is always treated as a member even if the members array drifts', async () => {
  const owner = await makeUser('own');
  const board = await makeBoard(owner.token, 'Drift');
  const { Board } = await import('../models/Board.js');

  await Board.updateOne({ _id: board.id }, { $set: { members: [] } });

  const socket = await open(owner.token);
  const join = await emit(socket, 'board:join', { boardId: board.id });
  assert.equal(join.status, 'ok');
  assert.equal(join.role, 'owner');

  const write = await emit(socket, 'card:create', {
    boardId: board.id,
    listId: board.lists[0].id,
    title: 'Still works'
  });
  assert.equal(write.status, 'ok');
});

test('an unauthenticated socket cannot emit anything', async () => {
  const { io } = await import('socket.io-client');
  const base = (await import('./helpers.js')).getBaseUrl();

  const socket = io(base, { transports: ['websocket'], forceNew: true });
  const error = await new Promise((resolve) => {
    socket.once('connect_error', (err) => resolve(err.message));
    socket.once('connect', () => resolve(null));
  });
  assert.ok(error, 'connection without a token must be refused');
  socket.close();
});
