import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

// Env must be set before anything pulls in config/index.js, and ESM hoists
// static imports above this file's own statements. So every import below is
// dynamic, and each module is reached only after the variables exist.
//
// This file gets its own process (node --test runs one per file), which is what
// makes it safe to pretend credentials are configured while the rest of the
// suite deliberately has none.
process.env.GOOGLE_CLIENT_ID = 'test-google-id.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-google-secret';
process.env.GITHUB_CLIENT_ID = 'test-github-id';
process.env.GITHUB_CLIENT_SECRET = 'test-github-secret';
process.env.PUBLIC_URL = 'https://api.example.test';

const { startTestServer, stopTestServer, getBaseUrl, request } = await import('./helpers.js');
const { availableProviders, PROVIDERS } = await import('../utils/oauth.js');

before(async () => {
  await startTestServer();
});
after(async () => {
  await stopTestServer();
});

const get = (path) => fetch(`${getBaseUrl()}${path}`, { redirect: 'manual' });

test('configured credentials make both providers available', () => {
  assert.deepEqual(availableProviders().sort(), ['github', 'google']);
});

test('the provider list carries a label for the UI', async () => {
  const res = await request('GET', '/auth/providers');
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.providers.map((p) => p.id).sort(),
    ['github', 'google']
  );
  assert.equal(res.body.providers.find((p) => p.id === 'google').label, PROVIDERS.google.label);
});

test('the google redirect is built correctly', async () => {
  const res = await get('/auth/google');
  assert.equal(res.status, 302);

  const to = res.headers.get('location');
  const url = new URL(to);

  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.pathname, '/o/oauth2/v2/auth');

  assert.equal(url.searchParams.get('client_id'), process.env.GOOGLE_CLIENT_ID);
  assert.equal(
    url.searchParams.get('redirect_uri'),
    'https://api.example.test/auth/google/callback',
    'the redirect URI must be derived from PUBLIC_URL, not guessed'
  );
  assert.equal(url.searchParams.get('response_type'), 'code');

  // The scopes the profile fetch depends on. Losing these means losing the
  // email, which means the account can never be linked.
  const scope = url.searchParams.get('scope');
  for (const required of ['openid', 'email', 'profile']) {
    assert.ok(scope.includes(required), `scope is missing ${required}: ${scope}`);
  }

  // PKCE: the challenge goes out, the verifier must not.
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  const challenge = url.searchParams.get('code_challenge');
  assert.ok(challenge && challenge.length >= 43, `challenge looks wrong: ${challenge}`);
  assert.match(challenge, /^[A-Za-z0-9_-]+$/, 'a challenge must be base64url');

  const state = url.searchParams.get('state');
  assert.ok(state && state.length >= 32, `state looks weak: ${state}`);

  // The PKCE bug this guards: handing arctic a pre-computed challenge where a
  // verifier belongs yields a well-formed URL that fails only at Google, on the
  // first real sign-in. A `code_verifier` in the outbound URL would mean the
  // secret left the server and PKCE protects nothing.
  assert.equal(url.searchParams.get('code_verifier'), null, 'the verifier must never leave the server');
});

test('the github redirect is built correctly', async () => {
  const res = await get('/auth/github');
  assert.equal(res.status, 302);

  const url = new URL(res.headers.get('location'));
  assert.equal(url.origin, 'https://github.com');
  assert.equal(url.pathname, '/login/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), process.env.GITHUB_CLIENT_ID);
  assert.equal(url.searchParams.get('redirect_uri'), 'https://api.example.test/auth/github/callback');

  // user:email is the only source of the `verified` flag, so without it GitHub
  // accounts can never link to an existing FlowBoard account.
  assert.ok(url.searchParams.get('scope').includes('user:email'));

  // GitHub does not support PKCE, so no challenge must be advertised.
  assert.equal(url.searchParams.get('code_challenge'), null);
  assert.ok(url.searchParams.get('state'));
});

test('each sign-in attempt gets a fresh state', async () => {
  const a = new URL((await get('/auth/google')).headers.get('location'));
  const b = new URL((await get('/auth/google')).headers.get('location'));
  assert.notEqual(a.searchParams.get('state'), b.searchParams.get('state'));
});

test('an unknown provider is refused', async () => {
  const res = await get('/auth/facebook');
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /Unknown provider/);
});

test('a callback with a state that was never issued is refused', async () => {
  const res = await get('/auth/google/callback?code=abc&state=never-issued');
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /#auth=invalid-state/);
  // The forged code must not survive anywhere in the response.
  assert.ok(!res.headers.get('location').includes('abc'));
});

test('a callback with no code is refused', async () => {
  const url = new URL((await get('/auth/google')).headers.get('location'));
  const res = await get(`/auth/google/callback?state=${url.searchParams.get('state')}`);
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /#auth=failed/);
});

test('a provider-reported error is surfaced as a cancellation', async () => {
  const res = await get('/auth/github/callback?error=access_denied&state=whatever');
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /#auth=cancelled/);
});

test('a state cannot be reused across providers', async () => {
  const google = new URL((await get('/auth/google')).headers.get('location'));
  const state = google.searchParams.get('state');
  // Same state, different provider: the stored entry records the provider, so
  // this must not resolve.
  const res = await get(`/auth/github/callback?code=abc&state=${state}`);
  assert.match(res.headers.get('location'), /#auth=invalid-state/);
});

test('no JWT is ever placed in a redirect URL', async () => {
  // Every failure path above must carry only a status fragment. A token in a
  // query string or fragment would leak into history, Referer and proxy logs.
  for (const path of [
    '/auth/google/callback?code=abc&state=nope',
    '/auth/github/callback?error=access_denied&state=nope'
  ]) {
    const res = await get(path);
    assert.match(res.headers.get('location'), /#auth=/);
    assert.ok(!/[?&]token=/.test(res.headers.get('location')));
  }
});

test('an exchange without a code is rejected', async () => {
  const res = await request('POST', '/auth/exchange', { body: {} });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /expired/);
});

test('an exchange with an unknown code is rejected', async () => {
  const res = await request('POST', '/auth/exchange', { body: { code: 'made-up-code' } });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /expired/);
});
