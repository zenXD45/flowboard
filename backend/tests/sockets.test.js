import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer,
  stopTestServer,
  resetDatabase,
  makeUser,
  connect,
  emit,
  listen,
  collect,
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

after(async () => {
  for (const s of sockets) s.close();
});

async function party() {
  const owner = await makeUser('own');
  const mate = await makeUser('mate');
  const board = await makeBoard(owner.token, 'Realtime Board');
  const ownerSocket = await open(owner.token);
  const mateSocket = await open(mate.token);
  await emit(ownerSocket, 'board:join', { boardId: board.id });
  await emit(ownerSocket, 'member:add', { boardId: board.id, username: mate.username, role: 'member' });
  await emit(mateSocket, 'board:join', { boardId: board.id });
  return { owner, mate, board, ownerSocket, mateSocket };
}

test('the socket handshake rejects a missing or forged token', async () => {
  await assert.rejects(() => connect('nonsense'), /signed in/);
});

test('board:create seeds three lists and makes the creator owner', async () => {
  const owner = await makeUser('own');
  const socket = await open(owner.token);

  const ack = await emit(socket, 'board:create', { title: 'Launch plan' });
  assert.equal(ack.status, 'ok');
  assert.deepEqual(ack.board.lists.map((l) => l.title), ['To Do', 'In Progress', 'Done']);
  assert.equal(ack.board.members[0].role, 'owner');
  assert.equal(ack.board.ownerId, owner.id);
});

test('board:create refuses an empty title', async () => {
  const owner = await makeUser('own');
  const socket = await open(owner.token);
  const ack = await emit(socket, 'board:create', { title: '   ' });
  assert.equal(ack.status, 'error');
  assert.equal(ack.code, 'bad_request');
});

test('a non-member cannot join the board room', async () => {
  const owner = await makeUser('own');
  const stranger = await makeUser('str');
  const board = await makeBoard(owner.token);
  const socket = await open(stranger.token);

  const ack = await emit(socket, 'board:join', { boardId: board.id });
  assert.equal(ack.status, 'error');
  assert.equal(ack.code, 'forbidden');
});

test('a member sees another member card move in real time', async () => {
  const { board, ownerSocket, mateSocket } = await party();
  const listId = board.lists[0].id;

  const card = await emit(ownerSocket, 'card:create', { boardId: board.id, listId, title: 'Ship it' });
  assert.equal(card.status, 'ok');

  const incoming = listen(mateSocket, 'card:moved');
  const moved = await emit(ownerSocket, 'card:move', {
    boardId: board.id,
    cardId: card.card.id,
    toListId: listId,
    index: 0,
    expectedVersion: card.card.version
  });
  assert.equal(moved.status, 'ok');

  const event = await incoming;
  assert.equal(event.card.id, card.card.id);
  assert.equal(event.card.version, 2);
});

test('the originator also receives the authoritative echo of its own move', async () => {
  const { board, ownerSocket } = await party();
  const listId = board.lists[0].id;
  const card = await emit(ownerSocket, 'card:create', { boardId: board.id, listId, title: 'Echo' });

  const selfEcho = listen(ownerSocket, 'card:moved');
  await emit(ownerSocket, 'card:move', {
    boardId: board.id,
    cardId: card.card.id,
    toListId: listId,
    index: 0,
    expectedVersion: card.card.version
  });

  const event = await selfEcho;
  assert.equal(event.card.version, 2, 'client must reconcile against server truth, not its guess');
});

test('a move with a stale expectedVersion is refused as a conflict', async () => {
  const { board, ownerSocket } = await party();
  const listId = board.lists[0].id;
  const card = await emit(ownerSocket, 'card:create', { boardId: board.id, listId, title: 'Contended' });

  await emit(ownerSocket, 'card:update', {
    boardId: board.id,
    cardId: card.card.id,
    patch: { title: 'Renamed by someone else' },
    expectedVersion: card.card.version
  });

  const stale = await emit(ownerSocket, 'card:move', {
    boardId: board.id,
    cardId: card.card.id,
    toListId: listId,
    index: 0,
    expectedVersion: card.card.version
  });

  assert.equal(stale.status, 'conflict');
  assert.equal(stale.card.version, 2);
  assert.equal(stale.card.title, 'Renamed by someone else');
});

test('two simultaneous moves of the same card produce exactly one winner', async () => {
  const { board, ownerSocket, mateSocket } = await party();
  const listId = board.lists[0].id;
  const card = await emit(ownerSocket, 'card:create', { boardId: board.id, listId, title: 'Race' });

  const move = (socket, index) =>
    emit(socket, 'card:move', {
      boardId: board.id,
      cardId: card.card.id,
      toListId: listId,
      index,
      expectedVersion: card.card.version
    });

  const [a, b] = await Promise.all([move(ownerSocket, 0), move(mateSocket, 1)]);

  const outcomes = [a.status, b.status].sort();
  assert.deepEqual(outcomes, ['conflict', 'ok'], `expected one ok and one conflict, got ${outcomes}`);

  const winner = a.status === 'ok' ? a : b;
  assert.equal(winner.card.version, 2);
});

test('card:move refuses to move a card into a list belonging to another board', async () => {
  const { owner, board, ownerSocket } = await party();
  const mine = await emit(ownerSocket, 'card:create', {
    boardId: board.id,
    listId: board.lists[0].id,
    title: 'Mine'
  });

  const otherBoard = await makeBoard(owner.token, 'Other');
  const ack = await emit(ownerSocket, 'card:move', {
    boardId: board.id,
    cardId: mine.card.id,
    toListId: otherBoard.lists[0].id,
    index: 0,
    expectedVersion: mine.card.version
  });

  assert.equal(ack.status, 'error');
  assert.equal(ack.code, 'not_found');
});

test('card:move refuses a cardId the caller cannot reach', async () => {
  const owner = await makeUser('own');
  const stranger = await makeUser('str');
  const board = await makeBoard(owner.token);
  const ownerSocket = await open(owner.token);
  await emit(ownerSocket, 'board:join', { boardId: board.id });

  const victim = await emit(ownerSocket, 'card:create', {
    boardId: board.id,
    listId: board.lists[0].id,
    title: 'Victim'
  });

  const socket = await open(stranger.token);
  const ack = await emit(socket, 'card:move', {
    boardId: board.id,
    cardId: victim.card.id,
    toListId: board.lists[1].id,
    index: 0,
    expectedVersion: 1
  });

  assert.equal(ack.status, 'error');
  assert.equal(ack.code, 'forbidden');
});

test('expectedVersion is mandatory on writes', async () => {
  const { board, ownerSocket } = await party();
  const card = await emit(ownerSocket, 'card:create', {
    boardId: board.id,
    listId: board.lists[0].id,
    title: 'Needs a version'
  });

  const ack = await emit(ownerSocket, 'card:update', {
    boardId: board.id,
    cardId: card.card.id,
    patch: { title: 'No version supplied' }
  });
  assert.equal(ack.status, 'error');
  assert.equal(ack.code, 'bad_request');
});

test('inserting between two cards keeps fractional order without rewriting neighbours', async () => {
  const { board, ownerSocket } = await party();
  const listId = board.lists[0].id;

  const first = await emit(ownerSocket, 'card:create', { boardId: board.id, listId, title: 'A', index: 0 });
  const last = await emit(ownerSocket, 'card:create', { boardId: board.id, listId, title: 'B', index: 1 });
  const middle = await emit(ownerSocket, 'card:create', { boardId: board.id, listId, title: 'Middle', index: 1 });

  assert.ok(first.card.position < middle.card.position);
  assert.ok(middle.card.position < last.card.position);
});

test('list:delete removes the list and cascades its cards', async () => {
  const { board, ownerSocket } = await party();
  const listId = board.lists[1].id;
  await emit(ownerSocket, 'card:create', { boardId: board.id, listId, title: 'Doomed' });

  const echo = listen(ownerSocket, 'list:deleted');
  const ack = await emit(ownerSocket, 'list:delete', { boardId: board.id, listId });
  assert.equal(ack.status, 'ok');
  assert.equal(ack.removedCardIds.length, 1);

  const event = await echo;
  assert.equal(event.listId, listId);

  const { Card } = await import('../models/Card.js');
  assert.equal(await Card.countDocuments({ boardId: board.id, listId }), 0);
});

test('presence:sync lists everyone currently in the room', async () => {
  const owner = await makeUser('own');
  const mate = await makeUser('mate');
  const board = await makeBoard(owner.token);
  const ownerSocket = await open(owner.token);
  const mateSocket = await open(mate.token);

  await emit(ownerSocket, 'board:join', { boardId: board.id });
  await emit(ownerSocket, 'member:add', { boardId: board.id, username: mate.username, role: 'member' });

  const presence = listen(mateSocket, 'presence:sync');
  await emit(mateSocket, 'board:join', { boardId: board.id });

  const event = await presence;
  const ids = event.users.map((u) => u.userId).sort();
  assert.deepEqual(ids, [owner.id, mate.id].sort());
  assert.ok(event.users.every((u) => u.username && u.username !== 'unknown'));
});

test('presence drops a user when their socket disconnects', async () => {
  const owner = await makeUser('own');
  const mate = await makeUser('mate');
  const board = await makeBoard(owner.token);
  const ownerSocket = await open(owner.token);
  const mateSocket = await open(mate.token);

  await emit(ownerSocket, 'board:join', { boardId: board.id });
  await emit(ownerSocket, 'member:add', { boardId: board.id, username: mate.username, role: 'member' });
  await emit(mateSocket, 'board:join', { boardId: board.id });

  const departure = listen(ownerSocket, 'presence:sync');
  mateSocket.close();

  const event = await departure;
  const ids = event.users.map((u) => u.userId);
  assert.ok(!ids.includes(mate.id), 'departed user should be gone');
  assert.ok(ids.includes(owner.id));
});

test('board:deleted reaches everyone in the room', async () => {
  const { board, ownerSocket, mateSocket } = await party();
  const gone = listen(mateSocket, 'board:deleted');
  const ack = await emit(ownerSocket, 'board:delete', { boardId: board.id });
  assert.equal(ack.status, 'ok');
  const event = await gone;
  assert.equal(event.boardId, board.id);
});

test('a mutation broadcasts exactly one event per recipient', async () => {
  const { board, ownerSocket, mateSocket } = await party();
  const watcher = collect(mateSocket, 'card:created');

  await emit(ownerSocket, 'card:create', {
    boardId: board.id,
    listId: board.lists[0].id,
    title: 'Once'
  });

  await watcher.waitFor(1);
  await new Promise((r) => setTimeout(r, 250));
  watcher.stop();
  assert.equal(watcher.seen.length, 1);
});

test('a board member cannot be written into another board room', async () => {
  const owner = await makeUser('own');
  const mate = await makeUser('mate');
  const boardA = await makeBoard(owner.token, 'A');
  const boardB = await makeBoard(owner.token, 'B');

  await emit(await open(owner.token), 'board:join', { boardId: boardA.id });
  const ownerB = await open(owner.token);
  await emit(ownerB, 'board:join', { boardId: boardB.id });
  await emit(ownerB, 'member:add', { boardId: boardB.id, username: mate.username, role: 'member' });

  const mateSocket = await open(mate.token);
  const ack = await emit(mateSocket, 'board:join', { boardId: boardA.id });
  assert.equal(ack.status, 'error', 'membership in B grants nothing in A');
});
