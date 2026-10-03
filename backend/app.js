import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import config from './config/index.js';
import { isOriginAllowed, isSelfOrigin } from './utils/origins.js';
import { requireAuth } from './middleware/auth.js';
import * as auth from './controllers/auth.controller.js';
import * as profile from './controllers/profile.controller.js';
import * as boards from './controllers/boards.controller.js';
import { authRoutes } from './routes/auth.routes.js';

const staticDir = path.join(config.root, '..', 'frontend', 'dist');

export function createApp(overrides = {}) {
  const cfg = { ...config, ...overrides };
  const app = express();
  app.disable('x-powered-by');

  // Render terminates TLS and forwards the real visitor address in
  // X-Forwarded-For. Without trusting exactly one proxy hop, req.ip is Render's
  // own private address — identical for every request from every visitor — so
  // both rate limiters collapse into one site-wide bucket. That locks out
  // every user after 20 signups in 15 minutes, and lets a single client deny
  // service to everyone else just by retrying.
  //
  // 1, not true: Express then reads the *last* X-Forwarded-For entry, which is
  // the one Render appends, so a client cannot spoof its way to a fresh bucket
  // by sending its own X-Forwarded-For header.
  app.set('trust proxy', 1);

  const cspDirectives = {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    fontSrc: ["'self'"],
    imgSrc: ["'self'", 'data:', 'https:'],
    connectSrc: ["'self'", 'ws:', 'wss:'],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"]
  };
  app.use(helmet({ contentSecurityPolicy: { directives: cspDirectives } }));

  const corsMethods = ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'];
  const corsHeaders = ['Content-Type', 'Authorization'];

  app.use(
    cors((req, callback) => {
      const origin = req.headers.origin;
      const allowed =
        !origin ||
        isSelfOrigin(origin, req.headers.host) ||
        isOriginAllowed(cfg.frontendOrigins, origin);

      if (!allowed) {
        // Without this the only clue is a browser console message the operator
        // has to go and find, naming a header but not the allowlist that
        // rejected it. The server already knows both, so say so here.
        console.warn(
          `[cors] rejected origin "${origin}" — FRONTEND_URL allows: ${cfg.frontendOrigins.join(', ') || '(nothing)'}`
        );
      }

      callback(null, { origin: allowed, methods: corsMethods, allowedHeaders: corsHeaders });
    })
  );

  const apiLimiter = rateLimit({
    windowMs: 60_000,
    limit: 300,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => cfg.isTest && !cfg.testRatelimit
  });
  const authLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: cfg.testRatelimit ? 6 : 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => cfg.isTest && !cfg.testRatelimit
  });
  app.use('/api/', apiLimiter);
  app.use('/api/auth/signup', authLimiter);
  app.use('/api/auth/login', authLimiter);

  // An uploaded avatar is a data URL the browser already resized to 128x128, so
  // it is still far larger than the global 64 KB JSON limit. Only this one path
  // gets the larger parser; body-parser marks the request as parsed, so the
  // global parser below then skips it and the DoS surface stays where it was.
  app.use('/api/auth/avatar', express.json({ limit: cfg.avatarLimitBytes, type: ['application/json'] }));
  app.use(express.json({ limit: cfg.bodyLimitBytes, type: ['application/json'] }));
  app.use(express.urlencoded({ extended: false }));

  // Personalised JSON must never be revalidated. Express attaches an ETag by
  // default, and without an explicit Cache-Control the browser is free to
  // cache the response heuristically and answer the next request with 304 —
  // which carries no body. The client cannot read that as a session, so a
  // plain reload could sign the user out at random.
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/health', (_req, res) =>
    res.json({
      ok: true,
      uptime: process.uptime(),
      version: 'flowboard/1.0.0',
      // Derived from config, not from `io.adapter.name`: Socket.io's in-memory
      // adapter reports the literal string "adapter", which made the old
      // `|| 'in-memory'` fallback unreachable and the field meaningless.
      adapter: cfg.redisUrl ? 'redis' : 'memory'
    })
  );

  const api = express.Router();
  api.post('/auth/signup', auth.signup);
  api.post('/auth/login', auth.login);
  api.get('/auth/me', requireAuth, auth.me);
  // Profile and settings are reads *and* writes over HTTP. The read/write split
  // that puts board mutations on the socket is about board state, which needs
  // fan-out to a room; an account change concerns one user and has no room to
  // broadcast to, exactly like signup and login above.
  api.patch('/auth/me', requireAuth, profile.updateMe);
  api.post('/auth/avatar', requireAuth, profile.uploadAvatar);
  api.post('/auth/password', requireAuth, profile.changePassword);
  api.get('/auth/connections', requireAuth, profile.listConnections);
  api.post('/auth/link/:provider', requireAuth, profile.startLink);
  api.delete('/auth/connections/:provider', requireAuth, profile.unlinkConnection);
  api.delete('/auth/account', requireAuth, profile.deleteAccount);

  api.get('/users', requireAuth, auth.searchUsers);
  api.get('/users/directory', requireAuth, auth.directoryOf);
  // No requireAuth: an <img> tag cannot carry the Bearer token, and the id is an
  // opaque ObjectId that already appears in payloads the viewer was allowed to read.
  api.get('/users/:id/avatar', profile.getAvatar);

  api.get('/boards', requireAuth, boards.listBoards);
  api.get('/boards/:boardId', requireAuth, boards.getBoard);
  api.get('/boards/:boardId/activity', requireAuth, boards.getActivity);

  app.use('/api', api);

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // Social sign-in lives outside /api/, so the API limiters above do not cover
  // it. It gets its own: the start endpoint is cheap but generates state that
  // must stay unguessable, and the callback is the interesting target, so both
  // are bounded per client rather than left open.
  const oauthLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: cfg.testRatelimit ? 20 : 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => cfg.isTest && !cfg.testRatelimit
  });
  app.use('/auth/', oauthLimiter, authRoutes());

  if (fs.existsSync(staticDir)) {
    app.use(express.static(staticDir, { index: 'index.html', maxAge: '1h' }));
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  }

  app.use((err, _req, res, _next) => {
    const status = err.type === 'entity.too.large' ? 413 : 500;
    const message =
      status === 413 ? 'Payload too large' : cfg.isProduction ? 'Something went wrong' : err.message;
    if (status >= 500 && !cfg.isTest) console.error(err);
    res.status(status).json({ error: message });
  });

  return app;
}
