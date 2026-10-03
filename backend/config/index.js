import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOriginAllowlist } from '../utils/origins.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readEnv(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || String(value).trim() === '' ? fallback : String(value).trim();
}

const env = readEnv('NODE_ENV', 'development');
const port = Number(readEnv('PORT', '5002'));
const isProduction = env === 'production';
const isTest = env === 'test';
const isDevelopment = !isProduction && !isTest;

const config = {
  root,
  env,
  isProduction,
  isTest,
  isDevelopment,
  port,
  mongoUrl: readEnv('MONGODB_URL', 'mongodb://127.0.0.1:27017/flowboard'),
  frontendUrl: readEnv('FRONTEND_URL', 'http://localhost:5173'),
  // The same value, normalised and split, so both the HTTP layer and the
  // Socket.io handshake enforce one list instead of two that can drift.
  frontendOrigins: parseOriginAllowlist(readEnv('FRONTEND_URL', 'http://localhost:5173')),
  redisUrl: readEnv('REDIS_URL'),
  // Social sign-in. A provider is only offered when its id and secret are both
  // present, so a half-finished Render configuration degrades to "password
  // only" instead of showing a button that 500s.
  googleClientId: readEnv('GOOGLE_CLIENT_ID'),
  googleClientSecret: readEnv('GOOGLE_CLIENT_SECRET'),
  githubClientId: readEnv('GITHUB_CLIENT_ID'),
  githubClientSecret: readEnv('GITHUB_CLIENT_SECRET'),
  // The API's own public origin, used to build OAuth redirect URIs. Distinct
  // from FRONTEND_URL, which is the browser app.
  publicUrl: readEnv('PUBLIC_URL').replace(/\/+$/, ''),
  // Render's free tier sleeps after ~15 idle minutes. Production pings its own
  // /health endpoint to stay warm; development and tests never do.
  keepAlive: isProduction && readEnv('SELF_PING', 'on').toLowerCase() !== 'off',
  keepAliveIntervalMs: Number(readEnv('SELF_PING_INTERVAL_MS', '600000')),
  jwtSecret: readEnv('JWT_SECRET', isProduction ? '' : 'flowboard-dev-only-secret-not-for-prod'),
  jwtTtlDays: Number(readEnv('JWT_TTL_DAYS', '7')),
  bodyLimitBytes: 64 * 1024,
  maxListsPerBoard: 30,
  maxCardsPerList: 500,
  activityPageSize: 40
};

if (isProduction && !config.jwtSecret) {
  throw new Error('Production requires JWT_SECRET');
}

// Fail loudly at boot rather than at the first click: a provider configured
// without PUBLIC_URL can only produce a redirect URI of "undefined/auth/...",
// which the provider would reject with an opaque error.
if (isProduction && (config.googleClientId || config.githubClientId) && !config.publicUrl) {
  throw new Error('Social sign-in is configured but PUBLIC_URL is not set');
}

export default config;
