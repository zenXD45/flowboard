import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { User } from '../models/User.js';
import { OAuthAccount } from '../models/OAuthAccount.js';
import { claimUsername, resolveUser, availableProviders, PROVIDERS } from '../utils/oauth.js';
import { startTestServer, stopTestServer, resetDatabase } from './helpers.js';

before(async () => {
  await startTestServer();
});
after(async () => {
  await stopTestServer();
});
beforeEach(async () => {
  await resetDatabase();
});

const profile = (over = {}) => ({
  providerUserId: 'p-1',
  email: 'ada@example.com',
  emailVerified: true,
  usernameHint: 'ada',
  name: 'Ada',
  avatar: '',
  ...over
});

test('a provider identity maps to exactly one account', async () => {
  const user = await User.create({ username: 'dupe-check', passwordHash: 'x' });
  await OAuthAccount.create({ provider: 'google', providerUserId: 'dupe-1', userId: user._id });

  await assert.rejects(
    OAuthAccount.create({ provider: 'google', providerUserId: 'dupe-1', userId: user._id }),
    /duplicate key/,
    'a second callback for the same identity must not be able to claim it'
  );
});

test('one user can hold both google and github', async () => {
  const user = await User.create({ username: 'two-providers', passwordHash: 'x' });
  await OAuthAccount.create({ provider: 'google', providerUserId: 'g-1', userId: user._id });
  await OAuthAccount.create({ provider: 'github', providerUserId: 'gh-1', userId: user._id });
  assert.equal((await OAuthAccount.find({ userId: user._id }).lean()).length, 2);
});

test('a social account has no password and stores no unverified email', async () => {
  const { user } = await resolveUser('google', profile({ providerUserId: 'nopass', email: '', emailVerified: false }));
  assert.equal(user.passwordHash, '');
  assert.equal(user.emailVerified, false);
  assert.equal(user.email, undefined, 'an unverified address must not be stored on the account');
});

test('a verified email links the identity to the existing account', async () => {
  const existing = await User.create({ username: 'existing-owner', email: 'link@example.com', passwordHash: 'x' });
  const { user, linked, created } = await resolveUser(
    'google',
    profile({ providerUserId: 'link-1', email: 'link@example.com', usernameHint: 'link-guy' })
  );

  assert.equal(linked, true);
  assert.equal(created, false);
  assert.equal(String(user._id), String(existing._id), 'must land on the pre-existing account');
  assert.equal(user.username, 'existing-owner', 'the local username is not replaced by the provider hint');
});

test('an UNVERIFIED email matching an account does not link', async () => {
  const victim = await User.create({ username: 'victim-owner', email: 'victim@example.com', passwordHash: 'x' });
  const { user, linked, created } = await resolveUser(
    'github',
    profile({ providerUserId: 'atk-1', email: 'victim@example.com', emailVerified: false, usernameHint: 'attacker' })
  );

  assert.equal(linked, false, 'an unverified email must never grant access to an existing account');
  assert.equal(created, true);
  assert.notEqual(String(user._id), String(victim._id));
  assert.equal(user.email, undefined);
});

test('re-signing-in with the same identity reuses the same account', async () => {
  const first = await resolveUser('google', profile({ providerUserId: 'again-1', email: 'again@example.com' }));
  const second = await resolveUser('google', profile({ providerUserId: 'again-1', email: 'again@example.com' }));

  assert.equal(String(first.user._id), String(second.user._id));
  assert.equal(second.created, false);
  assert.equal(second.linked, false);
});

test('google and github with the same verified email share one account', async () => {
  const g = await resolveUser('google', profile({ providerUserId: 'multi-g', email: 'multi@example.com', usernameHint: 'multi' }));
  const h = await resolveUser('github', profile({ providerUserId: 'multi-h', email: 'multi@example.com', usernameHint: 'multigh' }));
  assert.equal(String(g.user._id), String(h.user._id));
  assert.equal(h.linked, true);
});

test('an unverified provider email with no match still creates an account', async () => {
  const { user, created } = await resolveUser(
    'github',
    profile({ providerUserId: 'anon-1', email: 'nobody@example.com', emailVerified: false, usernameHint: 'anon' })
  );
  assert.equal(created, true);
  const accounts = await OAuthAccount.find({ userId: user._id }).lean();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].provider, 'github');
});

test('a repeat identity whose user row is gone creates a fresh account', async () => {
  const a = await resolveUser('google', profile({ providerUserId: 'orphan-1', email: 'orphan@example.com' }));
  await User.deleteOne({ _id: a.user._id });
  const b = await resolveUser('google', profile({ providerUserId: 'orphan-1', email: 'orphan@example.com' }));
  assert.equal(b.created, true);
});

test('claimUsername keeps a legal handle as-is', async () => {
  assert.equal(await claimUsername(User, 'ada', '1'), 'ada');
});

test('claimUsername strips characters the schema forbids', async () => {
  // Lowercased as part of sanitising, to satisfy the ^[a-z0-9_-]{3,24}$ validator.
  assert.equal(await claimUsername(User, 'Ada Lovelace!', '2'), 'ada-lovelace');
});

test('claimUsername never exceeds the 24 character schema limit', async () => {
  const name = await claimUsername(User, 'a'.repeat(60), '3');
  assert.ok(name.length <= 24, `${name} is ${name.length} chars`);
});

test('claimUsername suffixes on collision and stays within the limit', async () => {
  await User.create({ username: 'collide', passwordHash: 'x' });
  assert.equal(await claimUsername(User, 'collide', '4'), 'collide-2');
  await User.create({ username: 'collide-2', passwordHash: 'x' });
  assert.equal(await claimUsername(User, 'collide', '4'), 'collide-3');
});

test('claimUsername falls back to a usable name when the hint is unusable', async () => {
  for (const hint of ['', '...', '!!', undefined, null]) {
    const name = await claimUsername(User, hint, '99887766');
    assert.match(name, /^[a-z0-9_-]{3,24}$/, `"${hint}" produced ${name}`);
  }
});

test('claimUsername separates hints that sanitise to the same stem', async () => {
  // Both hints reduce to "sam-smith". The first must be persisted for the
  // second to see a collision — an uncommitted name occupies nothing.
  const first = await claimUsername(User, 'sam smith', '5');
  await User.create({ username: first, passwordHash: 'x' });
  const second = await claimUsername(User, 'sam-smith', '6');
  assert.equal(first, 'sam-smith');
  assert.equal(second, 'sam-smith-2');
});

test('only known providers are exposed', () => {
  assert.deepEqual(Object.keys(PROVIDERS).sort(), ['github', 'google']);
});

test('no credentials means no buttons', () => {
  // Tests run without provider env vars, so the UI must render nothing rather
  // than a button that leads to a 503.
  assert.deepEqual(availableProviders(), []);
});

test('google advertises PKCE and github does not', () => {
  assert.equal(PROVIDERS.google.pkce, true);
  assert.equal(PROVIDERS.github.pkce, false);
});
