import mongoose from 'mongoose';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import config from './config/index.js';
import { createApp } from './app.js';
import initSockets from './sockets/index.js';
import { startKeepAlive } from './utils/keepalive.js';

/**
 * Without Redis every Socket.io instance keeps its own room registry, so a
 * broadcast on instance A never reaches a client parked on instance B. The
 * adapter is what makes `io.to(room).emit()` cluster-wide. It is optional so
 * that local single-process development needs no extra service.
 */
async function attachAdapter(io) {
  if (!config.redisUrl) {
    console.log('[ws] no REDIS_URL — using in-memory adapter (single instance only)');
    return null;
  }
  const pub = createClient({ url: config.redisUrl });
  const sub = pub.duplicate();
  pub.on('error', (err) => console.error('[redis] publisher:', err.message));
  sub.on('error', (err) => console.error('[redis] subscriber:', err.message));
  await Promise.all([pub.connect(), sub.connect()]);
  io.adapter(createAdapter(pub, sub));
  console.log('[ws] redis adapter attached');
  return { pub, sub };
}

async function main() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(config.mongoUrl, { serverSelectionTimeoutMS: 4000 });
  console.log(`[db] connected ${config.mongoUrl}`);

  const app = createApp();
  const server = createServer(app);
  const io = new Server(server, {
    cors: { origin: config.frontendUrl, methods: ['GET', 'POST'] },
    maxHttpBufferSize: 40_960,
    pingInterval: 25_000,
    pingTimeout: 20_000
  });
  app.set('io', io);

  const redisClients = await attachAdapter(io);
  initSockets(io);

  const keepAlive = config.keepAlive
    ? startKeepAlive({ port: config.port, intervalMs: config.keepAliveIntervalMs })
    : null;

  server.listen(config.port, () => {
    console.log(`[api] listening on http://localhost:${config.port}`);
  });

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`[api] ${signal} — shutting down`);
    keepAlive?.stop();
    io.close();
    server.close(async () => {
      await Promise.allSettled([redisClients?.pub?.quit(), redisClients?.sub?.quit()]);
      await mongoose.disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[api] failed to start:', err.message);
  process.exit(1);
});
