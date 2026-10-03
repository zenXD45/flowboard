import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import config from './config/index.js';
import { requireAuth } from './middleware/auth.js';
import * as auth from './controllers/auth.controller.js';
import * as boards from './controllers/boards.controller.js';

const staticDir = path.join(config.root, '..', 'frontend', 'dist');

export function createApp(overrides = {}) {
  const cfg = { ...config, ...overrides };
  const app = express();
  app.disable('x-powered-by');

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

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || origin === cfg.frontendUrl) return callback(null, true);
        return callback(null, false);
      },
      methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization']
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
      adapter: app.get('io')?.adapter?.name || 'in-memory'
    })
  );

  const api = express.Router();
  api.post('/auth/signup', auth.signup);
  api.post('/auth/login', auth.login);
  api.get('/auth/me', requireAuth, auth.me);
  api.get('/users', requireAuth, auth.searchUsers);
  api.get('/users/directory', requireAuth, auth.directoryOf);

  api.get('/boards', requireAuth, boards.listBoards);
  api.get('/boards/:boardId', requireAuth, boards.getBoard);
  api.get('/boards/:boardId/activity', requireAuth, boards.getActivity);

  app.use('/api', api);

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

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
