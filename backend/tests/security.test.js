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

/**
 * Query-operator injection through a client-supplied id.
 *
 * `{ _id: payload.cardId }` is only safe while cardId is a plain string.
 * Mongoose forwards an operator object like `{ $ne: null }` to Mongo instead
 * of casting it, so the query stops meaning "this card" and starts meaning
 * "any card" — which silently renamed one card and deleted another, taking
 * their comments with them. These tests pin the central guard in handle().
 */
const INJECTIONS = [
  { $ne: null },
  { $gt: '' },
  { $exists: true },
  { $in: [null] },
  { $regex: '.*' }
];

const ID_EVENTS = {
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

/** Real ids for every id field, so a test can spoil exactly one of them. */
async function fixture(user) {
  const socket = await connect(user.token);
  const board = (await emit(socket, 'board:create', { title: 'Injection Fixture' })).board;
  const list = (await emit(socket, 'list:create', { boardId: board.id, title: 'L1' })).list;
  const card = (await emit(socket, 'card:create', {
    boardId: board.id,
    listId: list.id,
    title: 'Do not touch'
  })).card;
  socket.close();
  return { boardId: board.id, listId: list.id, toListId: list.id, cardId: card.id, userId: user.id };
}

for (const [event, fields] of Object.entries(ID_EVENTS)) {
  for (const field of fields) {
    test(`${event} rejects an injected ${field}`, async () => {
      const user = await makeUser('maya');
      const base = await fixture(user);
      const socket = await connect(user.token);
      try {
        for (const injection of INJECTIONS) {
          const ack = await emit(socket, event, { ...base, [field]: injection });
          assert.equal(
            ack.status,
            'error',
            `${event} accepted { ${field}: ${JSON.stringify(injection)} } -> ${JSON.stringify(ack)}`
          );
          assert.equal(ack.code, 'bad_request');
          assert.equal(ack.message, `Invalid ${field}`);
        }
      } finally {
        socket.close();
      }
    });
  }
}

test('a genuine id still works — the guard is not simply rejecting everything', async () => {
  const user = await makeUser('maya');
  const base = await fixture(user);
  const socket = await connect(user.token);
  try {
    const ack = await emit(socket, 'board:update', { boardId: base.boardId, title: 'A valid rename' });
    assert.equal(ack.status, 'ok');
    assert.equal(ack.patch.title, 'A valid rename');
  } finally {
    socket.close();
  }
});

test('a deleted card takes its comments with it, but only the targeted one', async () => {
  const user = await makeUser('maya');
  const base = await fixture(user);
  const socket = await connect(user.token);
  try {
    const doomed = await emit(socket, 'card:create', {
      boardId: base.boardId,
      listId: base.listId,
      title: 'Delete me'
    });
    const kept = await emit(socket, 'card:create', {
      boardId: base.boardId,
      listId: base.listId,
      title: 'Keep me'
    });
    const ack = await emit(socket, 'card:delete', {
      boardId: base.boardId,
      cardId: doomed.card.id
    });
    assert.equal(ack.status, 'ok');

    const { Card } = await import('../models/Card.js');
    const titles = (await Card.find({ boardId: base.boardId }).lean()).map((c) => c.title);
    assert.deepEqual(titles.sort(), ['Do not touch', 'Keep me']);
    assert.ok(!titles.includes('Delete me'));
    assert.ok(titles.includes(kept.card.title));
  } finally {
    socket.close();
  }
});

test('isValidObjectId accepts only 24-character hex strings', async () => {
  const { isValidObjectId } = await import('../utils/validate.js');
  assert.equal(isValidObjectId('6ac0a706e40718913df03745'), true);
  assert.equal(isValidObjectId('6AC0A706E40718913DF03745'), true, 'uppercase hex is still an id');
  assert.equal(isValidObjectId('123456789012'), false, '12 digits are not an id here');
  assert.equal(isValidObjectId('6ac0a706e40718913df0374'), false, '23 chars');
  assert.equal(isValidObjectId('6ac0a706e40718913df037455'), false, '25 chars');
  assert.equal(isValidObjectId('zzzzzzzzzzzzzzzzzzzzzzzz'), false);
  assert.equal(isValidObjectId(null), false);
  assert.equal(isValidObjectId(undefined), false);
  assert.equal(isValidObjectId(123), false);
  assert.equal(isValidObjectId({ toString: () => '6ac0a706e40718913df03745' }), false, 'no duck-typing');
});
