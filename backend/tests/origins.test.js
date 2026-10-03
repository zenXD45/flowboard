import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOrigin, parseOriginAllowlist, isOriginAllowed, hostOf, isSelfOrigin } from '../utils/origins.js';

test('normalizeOrigin drops whitespace, trailing slashes and case', () => {
  assert.equal(normalizeOrigin('  https://FlowBoard.vercel.app/  '), 'https://flowboard.vercel.app');
  assert.equal(normalizeOrigin('https://a.vercel.app///'), 'https://a.vercel.app');
  assert.equal(normalizeOrigin(''), '');
  assert.equal(normalizeOrigin(undefined), '');
});

test('parseOriginAllowlist splits, normalises and de-duplicates', () => {
  assert.deepEqual(
    parseOriginAllowlist('https://a.vercel.app, https://b.vercel.app/ ,https://a.vercel.app'),
    ['https://a.vercel.app', 'https://b.vercel.app']
  );
});

test('parseOriginAllowlist ignores empty entries from stray commas', () => {
  assert.deepEqual(parseOriginAllowlist(',,https://a.vercel.app,  ,'), ['https://a.vercel.app']);
  assert.deepEqual(parseOriginAllowlist(''), []);
});

test('an exactly configured origin is allowed', () => {
  const allow = parseOriginAllowlist('https://flowboard-nine-cyan.vercel.app');
  assert.equal(isOriginAllowed(allow, 'https://flowboard-nine-cyan.vercel.app'), true);
});

test('a trailing slash or capitalisation does not break the match', () => {
  const allow = parseOriginAllowlist('https://flowboard.vercel.app');
  assert.equal(isOriginAllowed(allow, 'https://flowboard.vercel.app/'), true);
  assert.equal(isOriginAllowed(allow, 'https://FlowBoard.vercel.app'), true);
});

test('a lookalike domain is rejected — no prefix or suffix matching', () => {
  const allow = parseOriginAllowlist('https://flowboard.vercel.app');
  assert.equal(isOriginAllowed(allow, 'https://evil-flowboard.vercel.app'), false);
  assert.equal(isOriginAllowed(allow, 'https://flowboard.vercel.app.evil.com'), false);
  assert.equal(isOriginAllowed(allow, 'https://flowboard.vercel.app.co'), false);
  assert.equal(isOriginAllowed(allow, 'http://flowboard.vercel.app'), false, 'scheme must match');
});

test('a different port is a different origin', () => {
  const allow = parseOriginAllowlist('http://localhost:5173');
  assert.equal(isOriginAllowed(allow, 'http://localhost:4173'), false);
  assert.equal(isOriginAllowed(allow, 'http://localhost:5173'), true);
});

test('any of several configured origins is accepted', () => {
  const allow = parseOriginAllowlist('https://prod.vercel.app,https://preview-1.vercel.app');
  assert.equal(isOriginAllowed(allow, 'https://preview-1.vercel.app'), true);
  assert.equal(isOriginAllowed(allow, 'https://preview-2.vercel.app'), false);
});

test('a request with no Origin is allowed — curl, health checks, server-to-server', () => {
  const allow = parseOriginAllowlist('https://flowboard.vercel.app');
  assert.equal(isOriginAllowed(allow, undefined), true);
  assert.equal(isOriginAllowed(allow, ''), true);
});

test('an empty allowlist rejects every browser origin', () => {
  assert.equal(isOriginAllowed([], 'https://flowboard.vercel.app'), false);
  assert.equal(isOriginAllowed([], undefined), true);
});

test('hostOf extracts host:port and rejects unparseable input', () => {
  assert.equal(hostOf('https://flowboard.vercel.app'), 'flowboard.vercel.app');
  assert.equal(hostOf('http://localhost:5173'), 'localhost:5173');
  assert.equal(hostOf('not-a-url'), null);
  assert.equal(hostOf(undefined), null);
});

test('isSelfOrigin recognises the API serving its own frontend', () => {
  assert.equal(isSelfOrigin('http://localhost:5002', 'localhost:5002'), true);
  assert.equal(isSelfOrigin('https://flowboard-gxu7.onrender.com', 'flowboard-gxu7.onrender.com'), true);
});

test('isSelfOrigin does not confuse a lookalike host', () => {
  assert.equal(isSelfOrigin('https://flowboard.vercel.app', 'flowboard.vercel.app.evil.com'), false);
  assert.equal(isSelfOrigin('http://localhost:5002', 'localhost:5173'), false);
  assert.equal(isSelfOrigin(undefined, 'localhost:5002'), false);
  assert.equal(isSelfOrigin('not-a-url', 'localhost:5002'), false);
});
