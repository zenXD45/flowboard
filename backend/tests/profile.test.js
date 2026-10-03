import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { User } from '../models/User.js';
import { OAuthAccount } from '../models/OAuthAccount.js';
import { Board } from '../models/Board.js';
import { Card } from '../models/Card.js';
import { Comment } from '../models/Comment.js';
import { Activity } from '../models/Activity.js';
import { signToken, signLinkToken, verifyLinkToken } from '../utils/token.js';
import { startTestServer, stopTestServer, resetDatabase, makeUser, getBaseUrl, request } from './helpers.js';

before(async () => {
  await startTestServer();
});
after(async () => {
  await stopTestServer();
});
beforeEach(async () => {
  await resetDatabase();
});

// Real PNG magic bytes, then padding. The server checks the signature, so a
// base64 blob of arbitrary text would be rejected as not-an-image.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;

/** A signed-in account with no password, reachable only through a provider. */
async function makeSocialUser(provider = 'google') {
  const user = await User.create({ username: `social${Math.random().toString(36).slice(2, 8)}` });
  await OAuthAccount.create({ provider, providerUserId: `pid-${Math.random()}`, userId: user._id });
  return { id: String(user._id), username: user.username, token: signToken(user._id) };
}

/* ------------------------------------------------------------- profile */

test('every profile endpoint refuses an anonymous caller', async () => {
  const calls = [
    ['PATCH', '/api/auth/me'],
    ['POST', '/api/auth/avatar'],
    ['POST', '/api/auth/password'],
    ['GET', '/api/auth/connections'],
    ['POST', '/api/auth/link/google'],
    ['DELETE', '/api/auth/connections/google'],
    ['DELETE', '/api/auth/account']
  ];
  for (const [method, path] of calls) {
    const res = await request(method, path, method === 'GET' ? {} : { body: {} });
    assert.equal(res.status, 401, `${method} ${path} must require a session`);
  }
});

test('a profile update changes the display name, handle and theme', async () => {
  const me = await makeUser('prof');
  const res = await request('PATCH', '/api/auth/me', {
    token: me.token,
    body: { displayName: 'Ada Lovelace', username: 'ada-l', theme: 'light', avatarColor: '2' }
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.displayName, 'Ada Lovelace');
  assert.equal(res.body.user.username, 'ada-l');
  assert.equal(res.body.user.theme, 'light');
  assert.equal(res.body.user.avatarColor, '2');

  const persisted = await User.findById(me.id).lean();
  assert.equal(persisted.displayName, 'Ada Lovelace');
  assert.equal(persisted.username, 'ada-l');
});

test('the profile response never leaks the password hash or the uploaded image', async () => {
  const me = await makeUser('leak');
  await request('POST', '/api/auth/avatar', { token: me.token, body: { image: PNG_DATA_URL } });
  const res = await request('GET', '/api/auth/me', { token: me.token });
  assert.equal(res.body.user.passwordHash, undefined);
  assert.equal(res.body.user.avatarUpload, undefined);
});

test('a handle already taken is a 409, not a 500', async () => {
  const first = await makeUser('taken');
  const second = await makeUser('other');
  const res = await request('PATCH', '/api/auth/me', { token: second.token, body: { username: first.username } });
  assert.equal(res.status, 409);
});

test('invalid field values are rejected with a clear message', async () => {
  const me = await makeUser('bad');
  const cases = [
    [{ username: 'ab' }, 'username'],
    [{ username: 'has spaces' }, 'username'],
    [{ displayName: 'x'.repeat(41) }, 'display'],
    [{ email: 'not-an-email' }, 'email'],
    [{ theme: 'neon' }, 'theme'],
    [{ avatarColor: '99' }, 'avatar colour'],
    [{ avatar: 'http://insecure.example/a.png' }, 'https']
  ];
  for (const [body, label] of cases) {
    const res = await request('PATCH', '/api/auth/me', { token: me.token, body });
    assert.equal(res.status, 400, `${label} should be rejected`);
    assert.match(res.body.error, new RegExp(label, 'i'));
  }
});

test('an email the user types is never treated as verified', async () => {
  const me = await makeUser('unverified');
  const res = await request('PATCH', '/api/auth/me', { token: me.token, body: { email: 'own@example.com' } });
  assert.equal(res.body.user.email, 'own@example.com');
  assert.equal(res.body.user.emailVerified, false, 'only a provider may mark an address verified');

  const cleared = await request('PATCH', '/api/auth/me', { token: me.token, body: { email: '' } });
  assert.equal(cleared.body.user.email, '');
});

test('a partial update leaves the other fields alone', async () => {
  const me = await makeUser('partial');
  await request('PATCH', '/api/auth/me', { token: me.token, body: { displayName: 'First', theme: 'dark' } });
  const res = await request('PATCH', '/api/auth/me', { token: me.token, body: { displayName: 'Second' } });
  assert.equal(res.body.user.displayName, 'Second');
  assert.equal(res.body.user.theme, 'dark', 'theme must survive an unrelated update');
});

/* -------------------------------------------------------------- avatar */

test('an uploaded avatar is stored by reference and served back', async () => {
  const me = await makeUser('avatar');
  const res = await request('POST', '/api/auth/avatar', { token: me.token, body: { image: PNG_DATA_URL } });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.avatar, `/users/${me.id}/avatar`, 'the payload carries a path, not the image');

  // Fetched the way an <img> would: no Authorization header.
  const served = await fetch(`${getBaseUrl()}/api/users/${me.id}/avatar`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG_BYTES);

  const db = await User.findById(me.id).lean();
  assert.ok(db.avatarUpload.startsWith('data:image/png;base64,'), 'the bytes live off the main avatar field');
});

test('an upload that is not really the image it claims is rejected', async () => {
  const me = await makeUser('fake');
  const html = Buffer.from('<svg onload=alert(1)>').toString('base64');
  const res = await request('POST', '/api/auth/avatar', {
    token: me.token,
    body: { image: `data:image/png;base64,${html}` }
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /valid image/i);
  assert.equal((await User.findById(me.id).lean()).avatarUpload, '');
});

test('an SVG upload is refused outright', async () => {
  const me = await makeUser('svg');
  const res = await request('POST', '/api/auth/avatar', {
    token: me.token,
    body: { image: `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}` }
  });
  assert.equal(res.status, 400);
});

test('an oversized upload is stopped by the body limit', async () => {
  const me = await makeUser('big');
  const huge = `data:image/png;base64,${'A'.repeat(600 * 1024)}`;
  // Its own connection: body-parser aborts the request at the limit, and a
  // pooled keep-alive socket left in that state would fail the *next* request.
  const res = await fetch(`${getBaseUrl()}/api/auth/avatar`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${me.token}`,
      Connection: 'close'
    },
    body: JSON.stringify({ image: huge })
  });
  assert.equal(res.status, 413);
  await res.text();
});

test('clearing the avatar URL removes any uploaded image too', async () => {
  const me = await makeUser('clear');
  await request('POST', '/api/auth/avatar', { token: me.token, body: { image: PNG_DATA_URL } });
  const res = await request('PATCH', '/api/auth/me', { token: me.token, body: { avatar: '' } });
  assert.equal(res.body.user.avatar, '');
  assert.equal((await User.findById(me.id).lean()).avatarUpload, '');
  assert.equal((await fetch(`${getBaseUrl()}/api/users/${me.id}/avatar`)).status, 404);
});

test('the avatar route 404s on a malformed or unknown id rather than throwing', async () => {
  assert.equal((await fetch(`${getBaseUrl()}/api/users/not-an-id/avatar`)).status, 404);
  assert.equal((await fetch(`${getBaseUrl()}/api/users/000000000000000000000000/avatar`)).status, 404);
});

/* ------------------------------------------------------------ password */

test('changing a password requires the current one', async () => {
  const me = await makeUser('pw');
  const wrong = await request('POST', '/api/auth/password', {
    token: me.token,
    body: { currentPassword: 'wrong-password', newPassword: 'brandnewpass1' }
  });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /current password/i);

  const ok = await request('POST', '/api/auth/password', {
    token: me.token,
    body: { currentPassword: 'supersecret123', newPassword: 'brandnewpass1' }
  });
  assert.equal(ok.status, 200);

  const relogin = await request('POST', '/api/auth/login', {
    body: { username: me.username, password: 'brandnewpass1' }
  });
  assert.equal(relogin.status, 200);
});

test('a short new password is rejected', async () => {
  const me = await makeUser('short');
  const res = await request('POST', '/api/auth/password', {
    token: me.token,
    body: { currentPassword: 'supersecret123', newPassword: 'short' }
  });
  assert.equal(res.status, 400);
});

test('a social-only account can set a first password without one to confirm', async () => {
  const social = await makeSocialUser();
  const res = await request('POST', '/api/auth/password', {
    token: social.token,
    body: { newPassword: 'firstpassword1' }
  });
  assert.equal(res.status, 200);
  const login = await request('POST', '/api/auth/login', {
    body: { username: social.username, password: 'firstpassword1' }
  });
  assert.equal(login.status, 200, 'the account must now be reachable by password');
});

/* --------------------------------------------------------- connections */

test('connections reports provider state, never the provider user id', async () => {
  const me = await makeUser('conn');
  await OAuthAccount.create({ provider: 'github', providerUserId: 'secret-pid', userId: me.id });
  const res = await request('GET', '/api/auth/connections', { token: me.token });
  const github = res.body.connections.find((c) => c.id === 'github');
  const google = res.body.connections.find((c) => c.id === 'google');
  assert.equal(github.connected, true);
  assert.equal(google.connected, false);
  assert.equal(JSON.stringify(res.body).includes('secret-pid'), false, 'provider ids stay server-side');
});

test('unlinking a provider works when a password remains', async () => {
  const me = await makeUser('unlink');
  await OAuthAccount.create({ provider: 'google', providerUserId: 'pid-1', userId: me.id });
  const res = await request('DELETE', '/api/auth/connections/google', { token: me.token });
  assert.equal(res.status, 200);
  assert.equal(await OAuthAccount.countDocuments({ userId: me.id }), 0);
});

test('the only sign-in method cannot be unlinked from a social-only account', async () => {
  const social = await makeSocialUser('google');
  const res = await request('DELETE', '/api/auth/connections/google', { token: social.token });
  assert.equal(res.status, 409);
  assert.equal(await OAuthAccount.countDocuments({ userId: social.id }), 1, 'the identity must survive');
});

test('unlinking a provider that is not linked is a 404', async () => {
  const me = await makeUser('nolink');
  assert.equal((await request('DELETE', '/api/auth/connections/github', { token: me.token })).status, 404);
  assert.equal((await request('DELETE', '/api/auth/connections/nope', { token: me.token })).status, 404);
});

test('a link token is scoped to linking and cannot act as a session', async () => {
  const me = await makeUser('linktok');
  const link = signLinkToken(me.id);
  assert.equal(verifyLinkToken(link)?.sub, me.id);
  assert.equal(verifyLinkToken(signToken(me.id)), null, 'a session token must not double as a link token');
  assert.equal(verifyLinkToken(`${link}x`), null);
});

test('starting a link on an unknown or unconfigured provider is refused', async () => {
  const me = await makeUser('linkbad');
  const unknown = await request('POST', '/api/auth/link/nope', { token: me.token });
  assert.equal(unknown.status, 404);
  // No provider credentials exist in the test environment, so this exercises
  // the "not configured" branch rather than a redirect to the provider.
  const off = await request('POST', '/api/auth/link/google', { token: me.token });
  assert.equal(off.status, 503);
});

/* ------------------------------------------------------------- deletion */

test('deleting an account demands the username typed back', async () => {
  const me = await makeUser('confirm');
  const res = await request('DELETE', '/api/auth/account', { token: me.token, body: { confirm: 'wrong' } });
  assert.equal(res.status, 400);
  assert.ok(await User.findById(me.id), 'the account must survive a bad confirmation');
});

test('deleting an account with a password checks it', async () => {
  const me = await makeUser('delpw');
  const res = await request('DELETE', '/api/auth/account', {
    token: me.token,
    body: { confirm: me.username, password: 'not-the-password' }
  });
  assert.equal(res.status, 400);
  assert.ok(await User.findById(me.id));
});

test('deleting an account removes the boards it owns and everything on them', async () => {
  const owner = await makeUser('owner');
  const board = await Board.create({
    title: 'Doomed',
    ownerId: owner.id,
    members: [{ userId: owner.id, role: 'owner' }],
    lists: [{ title: 'Todo', position: 1 }]
  });
  const listId = board.lists[0]._id;
  const card = await Card.create({ boardId: board._id, listId, title: 'Card', position: 1, createdBy: owner.id });
  await Comment.create({ boardId: board._id, cardId: card._id, authorId: owner.id, body: 'hi' });
  await Activity.create({ boardId: board._id, actorId: owner.id, verb: 'board.created' });
  await OAuthAccount.create({ provider: 'google', providerUserId: 'pid-x', userId: owner.id });

  const res = await request('DELETE', '/api/auth/account', {
    token: owner.token,
    body: { confirm: owner.username, password: 'supersecret123' }
  });
  assert.equal(res.status, 200);

  assert.equal(await User.findById(owner.id), null);
  assert.equal(await Board.countDocuments({ ownerId: owner.id }), 0);
  assert.equal(await Card.countDocuments({ boardId: board._id }), 0);
  assert.equal(await Comment.countDocuments({ boardId: board._id }), 0);
  assert.equal(await Activity.countDocuments({ boardId: board._id }), 0);
  assert.equal(await OAuthAccount.countDocuments({ userId: owner.id }), 0);
});

test('deleting an account leaves boards it was only a member of, unassigned', async () => {
  const owner = await makeUser('keepowner');
  const leaver = await makeUser('leaver');
  const board = await Board.create({
    title: 'Shared',
    ownerId: owner.id,
    members: [
      { userId: owner.id, role: 'owner' },
      { userId: leaver.id, role: 'member' }
    ],
    lists: [{ title: 'Todo', position: 1 }]
  });
  const card = await Card.create({
    boardId: board._id,
    listId: board.lists[0]._id,
    title: 'Assigned',
    position: 1,
    createdBy: owner.id,
    assigneeId: leaver.id
  });

  const res = await request('DELETE', '/api/auth/account', {
    token: leaver.token,
    body: { confirm: leaver.username, password: 'supersecret123' }
  });
  assert.equal(res.status, 200);

  const surviving = await Board.findById(board._id).lean();
  assert.ok(surviving, 'a board they did not own must not be deleted');
  assert.equal(surviving.members.some((m) => String(m.userId) === leaver.id), false);
  assert.equal((await Card.findById(card._id).lean()).assigneeId, null);
});
