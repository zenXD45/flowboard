import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startKeepAlive } from '../utils/keepalive.js';

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

const close = (server) => new Promise((resolve) => server.close(resolve));

test('pings the configured path and reports success', async () => {
  const hits = [];
  const logs = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    res.end('ok');
  });
  const port = await listen(server);
  const keepAlive = startKeepAlive({ port, path: '/health', log: (m) => logs.push(m) });

  try {
    await keepAlive.ping();
    assert.deepEqual(hits, ['/health']);
    assert.equal(logs.filter((l) => l.includes('responding')).length, 1);
  } finally {
    keepAlive.stop();
    await close(server);
  }
});

test('does not repeat a log line when the outcome is unchanged', async () => {
  const logs = [];
  const server = createServer((_req, res) => res.end('ok'));
  const port = await listen(server);
  const keepAlive = startKeepAlive({ port, log: (m) => logs.push(m) });

  try {
    await keepAlive.ping();
    await keepAlive.ping();
    await keepAlive.ping();
    assert.equal(logs.filter((l) => l.includes('responding')).length, 1);
  } finally {
    keepAlive.stop();
    await close(server);
  }
});

test('logs a failure once and carries on rather than throwing', async () => {
  const logs = [];
  const server = createServer((_req, res) => res.end('ok'));
  const port = await listen(server);
  await close(server); // nothing is listening now
  const keepAlive = startKeepAlive({ port, log: (m) => logs.push(m) });

  try {
    await keepAlive.ping();
    await keepAlive.ping();
    assert.equal(logs.filter((l) => l.includes('unreachable')).length, 1);
    assert.equal(logs.filter((l) => l.includes('responding')).length, 0);
  } finally {
    keepAlive.stop();
  }
});

test('treats a non-2xx health response as a failure', async () => {
  const logs = [];
  const server = createServer((_req, res) => {
    res.statusCode = 503;
    res.end('down');
  });
  const port = await listen(server);
  const keepAlive = startKeepAlive({ port, log: (m) => logs.push(m) });

  try {
    await keepAlive.ping();
    assert.ok(logs.some((l) => l.includes('unreachable')));
  } finally {
    keepAlive.stop();
    await close(server);
  }
});

test('stop() cancels the timer and suppresses further pings', async () => {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    res.end('ok');
  });
  const port = await listen(server);
  const keepAlive = startKeepAlive({ port, log: () => {} });

  keepAlive.stop();
  await keepAlive.ping();
  await close(server);

  assert.deepEqual(hits, []);
});

test('targets loopback so the ping needs no DNS or TLS', () => {
  const keepAlive = startKeepAlive({ port: 5002, path: '/health', log: () => {} });
  try {
    assert.equal(keepAlive.url, 'http://127.0.0.1:5002/health');
  } finally {
    keepAlive.stop();
  }
});

test('clamps a too-small interval so a typo cannot become a hot loop', () => {
  const keepAlive = startKeepAlive({ port: 5002, intervalMs: 1, log: () => {} });
  try {
    assert.equal(keepAlive.intervalMs, 60_000);
  } finally {
    keepAlive.stop();
  }
});

test('falls back to the default interval when the value is not a number', () => {
  const keepAlive = startKeepAlive({ port: 5002, intervalMs: 'soon', log: () => {} });
  try {
    assert.equal(keepAlive.intervalMs, 600_000);
  } finally {
    keepAlive.stop();
  }
});

test('refuses to start without a usable port', () => {
  assert.throws(() => startKeepAlive({ log: () => {} }), /valid port/);
  assert.throws(() => startKeepAlive({ port: 0, log: () => {} }), /valid port/);
});
