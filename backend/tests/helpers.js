import mongoose from 'mongoose';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { createApp } from '../app.js';
import initSockets from '../sockets/index.js';

const base = process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017/flowboard';

// `node --test` runs test *files* concurrently. If they shared one database,
// each file's beforeEach resetDatabase() would delete the other file's fixtures
// mid-run — producing failures that pass in isolation. So every file gets its
// own database, derived from its own filename.
export function withTestDatabase(url) {
  const qIndex = url.indexOf('?');
  const query = qIndex === -1 ? '' : url.slice(qIndex);
  const withoutQuery = qIndex === -1 ? url : url.slice(0, qIndex);
  const afterScheme = withoutQuery.indexOf('://') === -1 ? withoutQuery : withoutQuery.slice(withoutQuery.indexOf('://') + 3);
  const slug = (process.argv[1] || 'shared').split('/').pop().replace(/\.test\.js$/, '').replace(/[^a-z0-9]/gi, '');
  const suffix = `-test-${slug || 'shared'}`;
  const target = afterScheme.includes('/') ? `${withoutQuery}${suffix}` : `${withoutQuery}/flowboard${suffix}`;
  return `${target}${query}`;
}

const testUrl = withTestDatabase(base);

let server;
let io;
let baseUrl;

export async function startTestServer() {
  await mongoose.connect(testUrl, { serverSelectionTimeoutMS: 5000 });
  const app = createApp();
  server = createServer(app);
  io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 40_960 });
  app.set('io', io);
  initSockets(io);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
  return { baseUrl, io };
}

export async function stopTestServer() {
  if (io) await new Promise((resolve) => io.close(resolve));
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
}

export function getBaseUrl() {
  return baseUrl;
}

export function getIo() {
  return io;
}

export async function resetDatabase() {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
}

let counter = 0;

export async function makeUser(prefix = 'u') {
  counter += 1;
  const username = `${prefix}${counter}${Math.random().toString(36).slice(2, 6)}`;
  const res = await request('POST', '/api/auth/signup', {
    body: { username, password: 'supersecret123' }
  });
  if (res.status !== 201) throw new Error(`signup failed: ${JSON.stringify(res.body)}`);
  return { username, id: res.body.user.id, token: res.body.token };
}

export function request(method, path, { token, body } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));
}

export function connect(token) {
  return import('socket.io-client').then(({ io }) => {
    return new Promise((resolve, reject) => {
      const socket = io(baseUrl, { auth: { token }, transports: ['websocket'], forceNew: true });
      const fail = (err) => reject(new Error(err.message || 'connect failed'));
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', fail);
      setTimeout(() => reject(new Error('socket connect timeout')), 5000);
    });
  });
}

export function emit(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ack for "${event}"`)), 5000);
    socket.emit(event, payload, (ack) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

export function listen(socket, event, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`never received "${event}"`)), timeout);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

export async function makeBoard(token, title = 'Test Board') {
  const socket = await connect(token);
  const ack = await emit(socket, 'board:create', { title });
  socket.close();
  if (ack.status !== 'ok') throw new Error(`board:create failed: ${JSON.stringify(ack)}`);
  return ack.board;
}

export function collect(socket, event) {
  const seen = [];
  const handler = (payload) => seen.push(payload);
  socket.on(event, handler);
  return {
    seen,
    stop: () => socket.off(event, handler),
    async waitFor(count, timeout = 4000) {
      const deadline = Date.now() + timeout;
      while (seen.length < count) {
        if (Date.now() > deadline) {
          throw new Error(`expected ${count} "${event}" events, saw ${seen.length}`);
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      return seen;
    }
  };
}
