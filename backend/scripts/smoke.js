import { io as ioClient } from 'socket.io-client';
import config from '../config/index.js';

const BASE = `http://localhost:${config.port}`;
const results = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`${passed ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(BASE, { auth: { token }, transports: ['websocket'] });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function once(socket, event, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeout);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function emit(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ack for "${event}"`)), 5000);
    socket.emit(event, payload, (ack) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const stamp = Date.now().toString(36);

async function main() {
  console.log(`\nFlowBoard smoke — ${BASE}\n`);

  const owner = await api('/api/auth/signup', {
    method: 'POST',
    body: { username: `own_${stamp}`, password: 'supersecret123' }
  });
  check('owner signs up', owner.status === 201, owner.data?.error || '');

  const mate = await api('/api/auth/signup', {
    method: 'POST',
    body: { username: `mate_${stamp}`, password: 'supersecret123' }
  });
  check('collaborator signs up', mate.status === 201, mate.data?.error || '');

  const outsider = await api('/api/auth/signup', {
    method: 'POST',
    body: { username: `out_${stamp}`, password: 'supersecret123' }
  });
  check('non-member signs up', outsider.status === 201, '');

  const ownerToken = owner.data.token;
  const mateToken = mate.data.token;
  const outsiderToken = outsider.data.token;

  const ownerSocket = await connect(ownerToken);
  const mateSocket = await connect(mateToken);
  const outsiderSocket = await connect(outsiderToken);
  check('three sockets connect with JWT handshake', true);

  const created = await emit(ownerSocket, 'board:create', { title: 'Smoke Board' });
  check('board:create returns a board', created.status === 'ok', created.message || '');
  check('board seeds three default lists', created.board?.lists?.length === 3, JSON.stringify(created.board?.lists?.map((l) => l.title)));
  const boardId = created.board.id;

  const joinedOwner = await emit(ownerSocket, 'board:join', { boardId });
  check('owner joins board room', joinedOwner.status === 'ok', joinedOwner.message || '');
  check('owner receives the owner role', joinedOwner.role === 'owner', String(joinedOwner.role));

  const joinedOutsider = await emit(outsiderSocket, 'board:join', { boardId });
  check(
    'non-member is refused the room',
    joinedOutsider.status === 'error' && joinedOutsider.code === 'forbidden',
    joinedOutsider.message || ''
  );

  const added = await emit(ownerSocket, 'member:add', {
    boardId,
    username: mate.data.user.username,
    role: 'member'
  });
  check('owner adds collaborator', added.status === 'ok', added.message || '');

  // Arm the listener before joining: the server broadcasts presence *before* it
  // acks, so registering afterwards would miss the only emission.
  const presenceArrived = once(mateSocket, 'presence:sync');
  const joinedMate = await emit(mateSocket, 'board:join', { boardId });
  check('collaborator joins after being added', joinedMate.status === 'ok', joinedMate.message || '');

  const presence = await presenceArrived;
  const presenceIds = (presence.users || []).map((u) => u.userId);
  check(
    'presence lists both connected users',
    presenceIds.includes(owner.data.user.id) && presenceIds.includes(mate.data.user.id),
    JSON.stringify(presenceIds)
  );

  const list = created.board.lists[0];
  const cardOne = await emit(ownerSocket, 'card:create', { boardId, listId: list.id, title: 'Write the spec', index: 0 });
  check('card:create returns version 1', cardOne.card?.version === 1, `version=${cardOne.card?.version}`);
  const cardTwo = await emit(ownerSocket, 'card:create', { boardId, listId: list.id, title: 'Build the thing', index: 1 });
  check('fractional positions are ordered', cardOne.card.position < cardTwo.card.position, `${cardOne.card.position} < ${cardTwo.card.position}`);

  const broadcastSeen = once(ownerSocket, 'card:moved');
  const moved = await emit(mateSocket, 'card:move', {
    boardId,
    cardId: cardOne.card.id,
    toListId: list.id,
    index: 0,
    expectedVersion: 1
  });
  check('collaborator moves a card', moved.status === 'ok' && moved.card.version === 2, `version=${moved.card?.version}`);

  const seen = await broadcastSeen;
  check('originator also receives the authoritative echo', seen.card?.id === cardOne.card.id, seen.card?.id || '');

  const conflict = await emit(ownerSocket, 'card:move', {
    boardId,
    cardId: cardOne.card.id,
    toListId: list.id,
    index: 1,
    expectedVersion: 1
  });
  check(
    'stale expectedVersion is rejected as a conflict',
    conflict.status === 'conflict',
    `status=${conflict.status}`
  );
  check('conflict response carries server truth for rollback', conflict.card?.version === 2, `version=${conflict.card?.version}`);

  const badList = await emit(ownerSocket, 'card:create', {
    boardId,
    listId: '64b000000000000000000000',
    title: 'Should not exist',
    index: 0
  });
  check('card cannot be injected into a foreign list', badList.status === 'error', badList.message || '');

  const viewer = await emit(ownerSocket, 'member:add', {
    boardId,
    username: outsider.data.user.username,
    role: 'viewer'
  });
  check('owner adds a viewer', viewer.status === 'ok', viewer.message || '');

  const joinedViewer = await emit(outsiderSocket, 'board:join', { boardId });
  check('viewer can read the board', joinedViewer.status === 'ok' && joinedViewer.role === 'viewer', joinedViewer.role || joinedViewer.message || '');

  const viewerWrite = await emit(outsiderSocket, 'card:create', {
    boardId,
    listId: list.id,
    title: 'Viewer should not write',
    index: 0
  });
  check(
    'viewer is blocked from writing',
    viewerWrite.status === 'error' && viewerWrite.code === 'forbidden',
    viewerWrite.message || ''
  );

  const snapshot = await api(`/api/boards/${boardId}`, { token: ownerToken });
  check('REST snapshot returns board + cards + people', snapshot.status === 200 && snapshot.data.cards.length === 2, `${snapshot.data?.cards?.length} cards`);
  check('snapshot includes resolved usernames', typeof snapshot.data.people === 'object');

  // Regression guard: comments used to be write-only, so a refresh silently
  // emptied every thread even though the rows were sitting in Mongo.
  const cardId = snapshot.data.cards[0].id;
  const commentAck = await emit(ownerSocket, 'comment:add', { boardId, cardId, body: 'persisted by smoke' });
  check('comment is accepted', commentAck.status === 'ok', commentAck.message || '');

  const withComments = await api(`/api/boards/${boardId}`, { token: ownerToken });
  const returned = withComments.data.comments || [];
  check(
    'snapshot carries comments back with author names',
    returned.length === 1 && returned[0].body === 'persisted by smoke' && returned[0].authorName === owner.data.user.username,
    `${returned.length} comment(s)`
  );
  check(
    'snapshot exposes the board id the client needs to mutate',
    snapshot.data.board?.id === boardId,
    String(snapshot.data.board?.id)
  );

  const activity = await api(`/api/boards/${boardId}/activity`, { token: ownerToken });
  check('activity log records the mutations', activity.data?.activity?.length >= 3, `${activity.data?.activity?.length} entries`);

  const outsiderRead = await api(`/api/boards/${boardId}`, { token: outsiderToken });
  check('viewer can read via REST', outsiderRead.status === 200, String(outsiderRead.status));

  const anonRead = await api(`/api/boards/${boardId}`);
  check('anonymous REST read is rejected', anonRead.status === 401, String(anonRead.status));

  for (const socket of [ownerSocket, mateSocket, outsiderSocket]) socket.close();

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nsmoke crashed:', err.message);
  console.error('Is the API running?  npm start\n');
  process.exit(1);
});
