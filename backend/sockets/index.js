import config from '../config/index.js';
import { verifyToken } from '../utils/token.js';
import { User } from '../models/User.js';
import { loadAccess } from './access.js';
import { registerMutations } from './mutations.js';

const room = (boardId) => `board:${boardId}`;

/**
 * Presence is derived from Socket.io room membership rather than kept in a
 * separate store. Because the Redis adapter makes fetchSockets() cluster-wide,
 * this stays correct across multiple instances without a second source of truth
 * to keep in sync — or to leak from when a process dies.
 */
async function presenceOf(io, boardId) {
  const sockets = await io.in(room(boardId)).fetchSockets();
  const byUser = new Map();
  for (const s of sockets) {
    const id = s.data?.userId;
    if (!id) continue;
    const existing = byUser.get(id);
    if (existing) existing.sockets += 1;
    else byUser.set(id, { userId: id, username: s.data?.username || 'unknown', avatar: s.data?.avatar || '', sockets: 1 });
  }
  return [...byUser.values()];
}

async function broadcastPresence(io, boardId) {
  if (!boardId) return;
  io.to(room(boardId)).emit('presence:sync', { boardId, users: await presenceOf(io, boardId) });
}

/**
 * The handshake already proved the token is valid, so everything a client can
 * emit on needs its listener attached *synchronously*. Resolving the display
 * name is a nice-to-have and must never sit in front of listener registration:
 * Socket.io does not await an async connection handler, so an `await` above
 * registerMutations() opens a window where a client can emit into the void and
 * never receive an ack.
 */
function hydrateProfile(socket) {
  User.findById(socket.data.userId)
    .select('username avatar')
    .lean()
    .then(async (user) => {
      if (!user) return;
      socket.data.username = user.username;
      socket.data.avatar = user.avatar || '';
      for (const boardId of socket.data.boards) {
        await broadcastPresence(socket.io, boardId);
      }
    })
    .catch((err) => {
      if (!config.isTest) console.error('[ws] profile hydration failed:', err.message);
    });
}

export default function initSockets(io) {
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    const payload = typeof token === 'string' ? verifyToken(token) : null;
    if (!payload) return next(new Error('You must be signed in'));
    socket.data.userId = payload.sub;
    socket.data.username = 'unknown';
    socket.data.avatar = '';
    socket.data.boards = new Set();
    next();
  });

  io.on('connection', (socket) => {
    registerMutations(io, socket);

    socket.on('board:join', async (payload, ack) => {
      const respond = typeof ack === 'function' ? ack : () => {};
      try {
        const access = await loadAccess(payload?.boardId, socket.data.userId);
        if (access.error) {
          return respond({ status: 'error', code: access.code, message: access.error });
        }
        socket.join(room(access.board._id));
        socket.data.boards.add(String(access.board._id));
        await broadcastPresence(io, String(access.board._id));
        respond({ status: 'ok', role: access.role });
      } catch (err) {
        if (!config.isTest) console.error('[ws] board:join failed:', err);
        respond({ status: 'error', code: 'server_error', message: 'Something went wrong' });
      }
    });

    socket.on('board:leave', async (payload) => {
      const boardId = String(payload?.boardId || '');
      if (!boardId) return;
      socket.leave(room(boardId));
      socket.data.boards.delete(boardId);
      await broadcastPresence(io, boardId);
    });

    socket.on('disconnect', async () => {
      for (const boardId of socket.data.boards || []) {
        await broadcastPresence(io, boardId);
      }
    });

    hydrateProfile(socket);
  });
}
