import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, resetDatabase, makeUser, request } from './helpers.js';

before(async () => {
  await startTestServer();
});
after(async () => {
  await stopTestServer();
});
beforeEach(async () => {
  await resetDatabase();
});

test('signup creates an account and returns a JWT', async () => {
  const res = await request('POST', '/api/auth/signup', {
    body: { username: 'maya', password: 'supersecret123' }
  });
  assert.equal(res.status, 201);
  assert.ok(res.body.token);
  assert.equal(res.body.user.username, 'maya');
  assert.equal(res.body.user.passwordHash, undefined);
});

test('password is hashed, never stored in the clear', async () => {
  await request('POST', '/api/auth/signup', {
    body: { username: 'maya', password: 'supersecret123' }
  });
  const { User } = await import('../models/User.js');
  const stored = await User.findOne({ username: 'maya' }).lean();
  assert.notEqual(stored.passwordHash, 'supersecret123');
  assert.match(stored.passwordHash, /^\$2[aby]\$/);
});

test('signup rejects a username outside the allowed shape', async () => {
  for (const username of ['ab', 'has space', 'UPPER!', 'x'.repeat(25), '']) {
    const res = await request('POST', '/api/auth/signup', { body: { username, password: 'supersecret123' } });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(username)}`);
  }
});

test('signup rejects a short password', async () => {
  const res = await request('POST', '/api/auth/signup', { body: { username: 'maya', password: 'short' } });
  assert.equal(res.status, 400);
});

test('duplicate username is a 409, not a 500', async () => {
  await request('POST', '/api/auth/signup', { body: { username: 'maya', password: 'supersecret123' } });
  const res = await request('POST', '/api/auth/signup', {
    body: { username: 'maya', password: 'supersecret123' }
  });
  assert.equal(res.status, 409);
});

test('login succeeds with the right password and fails with the wrong one', async () => {
  await request('POST', '/api/auth/signup', { body: { username: 'maya', password: 'supersecret123' } });

  const good = await request('POST', '/api/auth/login', {
    body: { username: 'maya', password: 'supersecret123' }
  });
  assert.equal(good.status, 200);
  assert.ok(good.body.token);

  const bad = await request('POST', '/api/auth/login', { body: { username: 'maya', password: 'wrongpassword' } });
  assert.equal(bad.status, 401);
});

test('unknown user and wrong password give the same message', async () => {
  await request('POST', '/api/auth/signup', { body: { username: 'maya', password: 'supersecret123' } });
  const unknown = await request('POST', '/api/auth/login', { body: { username: 'ghost', password: 'whatever1' } });
  const wrong = await request('POST', '/api/auth/login', { body: { username: 'maya', password: 'whatever1' } });
  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(unknown.body.error, wrong.body.error);
});

test('username is case-insensitive on login', async () => {
  await request('POST', '/api/auth/signup', { body: { username: 'maya', password: 'supersecret123' } });
  const res = await request('POST', '/api/auth/login', {
    body: { username: 'MAYA', password: 'supersecret123' }
  });
  assert.equal(res.status, 200);
});

test('/api/auth/me requires a token and resolves the user', async () => {
  const user = await makeUser('me');

  const anon = await request('GET', '/api/auth/me');
  assert.equal(anon.status, 401);

  const bad = await request('GET', '/api/auth/me', { token: 'not-a-real-token' });
  assert.equal(bad.status, 401);

  const res = await request('GET', '/api/auth/me', { token: user.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.id, user.id);
});

test('a token signed with the wrong secret is rejected', async () => {
  const user = await makeUser('forge');
  const jwt = (await import('jsonwebtoken')).default;
  const forged = jwt.sign({ sub: user.id }, 'some-other-secret', { algorithm: 'HS256' });
  const res = await request('GET', '/api/auth/me', { token: forged });
  assert.equal(res.status, 401);
});

test('user search never leaks the caller or password hashes', async () => {
  const a = await makeUser('alpha');
  await makeUser('beta');

  const res = await request('GET', '/api/users?q=bet', { token: a.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.users.length, 1);
  assert.equal(res.body.users[0].passwordHash, undefined);
  assert.notEqual(res.body.users[0].id, a.id);
});
