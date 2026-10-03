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

async function seedBoard(token, { cards = 3 } = {}) {
  const board = await makeBoard(token, 'Snapshot Board');
  const socket = await open(token);
  await emit(socket, 'board:join', { boardId: board.id });
  for (let i = 0; i < cards; i += 1) {
    await emit(socket, 'card:create', { boardId: board.id, listId: board.lists[0].id, title: `Card ${i}`, index: i });
  }
  return { board, socket };
}

test('GET /api/boards lists only boards the caller belongs to', async () => {
  const mine = await makeUser('mine');
  const stranger = await makeUser('str');
  await makeBoard(mine.token, 'Mine');

  const res = await request('GET', '/api/boards', { token: mine.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.boards.length, 1);
  assert.equal(res.body.boards[0].title, 'Mine');
  assert.equal(res.body.boards[0].role, 'owner');
  assert.equal(res.body.boards[0].cardCount, 0);

  const theirs = await request('GET', '/api/boards', { token: stranger.token });
  assert.equal(theirs.body.boards.length, 0);
});

test('the board list carries card counts and resolved people', async () => {
  const user = await makeUser('cnt');
  await seedBoard(user.token, { cards: 3 });

  const res = await request('GET', '/api/boards', { token: user.token });
  assert.equal(res.body.boards[0].cardCount, 3);
  assert.equal(res.body.boards[0].people[0].username, user.username);
});

test('the board snapshot returns lists, cards, people and the caller role', async () => {
  const user = await makeUser('snap');
  const { board } = await seedBoard(user.token, { cards: 2 });

  const res = await request('GET', `/api/boards/${board.id}`, { token: user.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.role, 'owner');
  assert.equal(res.body.board.lists.length, 3);
  assert.equal(res.body.cards.length, 2);
  assert.equal(res.body.cards[0].version, 1);
  assert.equal(res.body.people[user.id].username, user.username);
});

test('snapshot cards come back in list then position order', async () => {
  const user = await makeUser('ord');
  const { board, socket } = await seedBoard(user.token, { cards: 3 });

  await emit(socket, 'card:create', { boardId: board.id, listId: board.lists[1].id, title: 'Other list', index: 0 });

  const res = await request('GET', `/api/boards/${board.id}`, { token: user.token });
  const firstList = res.body.cards.filter((c) => c.listId === board.lists[0].id);
  const positions = firstList.map((c) => c.position);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});

test('snapshot is 400 for a malformed id and 404 for a missing board', async () => {
  const user = await makeUser('bad');

  const malformed = await request('GET', '/api/boards/not-an-id', { token: user.token });
  assert.equal(malformed.status, 400);

  const missing = await request('GET', '/api/boards/64b000000000000000000000', { token: user.token });
  assert.equal(missing.status, 404);
});

test('snapshot is 403 for a signed-in non-member', async () => {
  const owner = await makeUser('own');
  const stranger = await makeUser('str');
  const board = await makeBoard(owner.token);

  const res = await request('GET', `/api/boards/${board.id}`, { token: stranger.token });
  assert.equal(res.status, 403);
  assert.equal(res.body.cards, undefined, 'a forbidden read must not leak card contents');
});

test('snapshot requires authentication', async () => {
  const owner = await makeUser('own');
  const board = await makeBoard(owner.token);
  const res = await request('GET', `/api/boards/${board.id}`);
  assert.equal(res.status, 401);
});

test('the activity feed records who did what, newest first', async () => {
  const user = await makeUser('act');
  const { board } = await seedBoard(user.token, { cards: 2 });

  const res = await request('GET', `/api/boards/${board.id}/activity`, { token: user.token });
  assert.equal(res.status, 200);
  const verbs = res.body.activity.map((a) => a.verb);
  assert.ok(verbs.includes('card.created'));
  assert.ok(res.body.activity.every((a) => typeof a.actorName === 'string'));
  assert.ok(new Date(res.body.activity[0].createdAt) >= new Date(res.body.activity.at(-1).createdAt));
});

test('the activity feed paginates with an opaque cursor', async () => {
  const user = await makeUser('page');
  const { board } = await seedBoard(user.token, { cards: 5 });

  const first = await request('GET', `/api/boards/${board.id}/activity?limit=2`, { token: user.token });
  assert.equal(first.body.activity.length, 2);
  assert.equal(first.body.hasMore, true);
  assert.ok(first.body.nextBefore);

  const second = await request(
    'GET',
    `/api/boards/${board.id}/activity?limit=2&before=${first.body.nextBefore}`,
    { token: user.token }
  );
  assert.equal(second.body.activity.length, 2);

  const firstIds = first.body.activity.map((a) => a.id);
  const secondIds = second.body.activity.map((a) => a.id);
  assert.equal(firstIds.some((id) => secondIds.includes(id)), false, 'pages must not overlap');
});

test('activity is 403 for a non-member and 401 when anonymous', async () => {
  const owner = await makeUser('own');
  const stranger = await makeUser('str');
  const board = await makeBoard(owner.token);

  assert.equal((await request('GET', `/api/boards/${board.id}/activity`, { token: stranger.token })).status, 403);
  assert.equal((await request('GET', `/api/boards/${board.id}/activity`)).status, 401);
});

test('unknown API routes return a JSON 404, not the SPA shell', async () => {
  const res = await request('GET', '/api/does-not-exist');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Not found');
});

test('the health endpoint is public and reports the adapter in use', async () => {
  const res = await request('GET', '/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.adapter);
});

test('an oversized JSON body is rejected before it reaches a handler', async () => {
  const user = await makeUser('big');
  const huge = { username: 'maya', password: 'x'.repeat(200_000) };
  const res = await request('POST', '/api/auth/signup', { body: huge });
  assert.ok([413, 400].includes(res.status), `expected 413/400, got ${res.status}`);
});
