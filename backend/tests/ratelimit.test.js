import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { createServer } from 'node:http';
import { createApp } from '../app.js';
import { withTestDatabase } from './helpers.js';

/**
 * Rate limiting keys off req.ip. Behind a reverse proxy that address is only
 * meaningful if the app is told to trust the hop in front of it — and the
 * failure mode is invisible in development, because on localhost every
 * request already has a distinct address.
 *
 * These tests send X-Forwarded-For the way Render does, one entry per client,
 * and assert each client gets its own bucket.
 */

const base = process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017/flowboard';
const testUrl = withTestDatabase(base);

let server;
let baseUrl;

before(async () => {
  await mongoose.connect(testUrl, { serverSelectionTimeoutMS: 5000 });
  // testRatelimit drops the auth limit to 6 so the test does not need 20
  // round trips to trip it.
  const app = createApp({ testRatelimit: true });
  server = createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

function attempt(forwardedFor) {
  return fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {})
    },
    body: JSON.stringify({ username: 'nobody-here', password: 'wrong-password' })
  });
}

test('each forwarded client address gets its own bucket', async () => {
  const ALLOWED = 6;

  for (let i = 0; i < ALLOWED; i += 1) {
    assert.equal((await attempt('203.0.113.10')).status, 401, `attempt ${i + 1} should be evaluated`);
  }
  assert.equal((await attempt('203.0.113.10')).status, 429, 'the first client should now be limited');

  // The whole point: one exhausted client must not lock out anyone else.
  assert.equal(
    (await attempt('203.0.113.99')).status,
    401,
    'a different client was rate limited by someone else\'s traffic'
  );
});

test('a spoofed X-Forwarded-For cannot buy a fresh bucket', async () => {
  // Render appends the real address, so the client's own header is not the
  // last entry and must not be the one that counts.
  for (let i = 0; i < 6; i += 1) {
    await attempt('198.51.100.7, 203.0.113.10');
  }
  assert.equal(
    (await attempt('198.51.100.7, 203.0.113.10')).status,
    429,
    'spoofing a new leading address should not reset the bucket'
  );
});
