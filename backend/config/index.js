import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  redisUrl: readEnv('REDIS_URL'),
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

export default config;
