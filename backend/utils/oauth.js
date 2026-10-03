import {
  Google,
  GitHub,
  generateState,
  generateCodeVerifier
} from 'arctic';
import config from '../config/index.js';
import { User } from '../models/User.js';
import { OAuthAccount } from '../models/OAuthAccount.js';

/**
 * Social sign-in, provider by provider.
 *
 * Each entry hides three things that differ between providers: whether PKCE is
 * supported, how the redirect URI is built, and how a profile is fetched and
 * normalised. Everything above this file works in one shape:
 *
 *     { providerUserId, email, emailVerified, usernameHint, name, avatar }
 *
 * `emailVerified` is the security-critical field. Linking a social identity to
 * an existing account by email is only safe when the provider *asserts* that
 * the email is verified. Trusting an unverified address would let anyone
 * register `victim@example.com` at a provider, sign in, and inherit the
 * victim's boards — so an unverified email never links, it only ever creates a
 * separate account.
 */

const GOOGLE_SCOPES = ['openid', 'email', 'profile'];
const GITHUB_SCOPES = ['read:user', 'user:email'];

const redirectUri = (provider) => `${config.publicUrl}/auth/${provider}/callback`;

async function getJson(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`profile request failed (${res.status})`);
  return res.json();
}

export const PROVIDERS = {
  google: {
    label: 'Google',
    // Google supports PKCE; the verifier must be echoed back on exchange.
    pkce: true,
    configured: () => Boolean(config.googleClientId && config.googleClientSecret),
    client: () => new Google(config.googleClientId, config.googleClientSecret, redirectUri('google')),
    authorizeUrl(client, state, codeVerifier) {
      return client.createAuthorizationURL(state, codeVerifier, GOOGLE_SCOPES).toString();
    },
    exchange(client, code, codeVerifier) {
      return client.validateAuthorizationCode(code, codeVerifier);
    },
    async profile(tokens) {
      const p = await getJson('https://www.googleapis.com/oauth2/v3/userinfo', {
        Authorization: `Bearer ${tokens.accessToken()}`
      });
      return {
        providerUserId: String(p.sub),
        email: p.email ? String(p.email).toLowerCase() : '',
        // Google returns email_verified explicitly; only `true` counts.
        emailVerified: p.email_verified === true,
        // Google exposes no username, so the email local-part is the most
        // stable human-recognisable handle available.
        usernameHint: p.email ? String(p.email).split('@')[0] : '',
        name: p.name || '',
        avatar: p.picture || ''
      };
    }
  },

  github: {
    label: 'GitHub',
    // GitHub's authorize step takes no PKCE verifier.
    pkce: false,
    configured: () => Boolean(config.githubClientId && config.githubClientSecret),
    client: () => new GitHub(config.githubClientId, config.githubClientSecret, redirectUri('github')),
    authorizeUrl(client, state) {
      return client.createAuthorizationURL(state, GITHUB_SCOPES).toString();
    },
    exchange(client, code) {
      return client.validateAuthorizationCode(code);
    },
    async profile(tokens) {
      const headers = {
        Authorization: `Bearer ${tokens.accessToken()}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'flowboard'
      };
      const user = await getJson('https://api.github.com/user', headers);

      // /user only carries an email when the account publishes one, and even
      // then it is not a verified signal. The dedicated endpoint is the only
      // source of the `verified` flag, so it is consulted every time rather
      // than only as a fallback — that is what makes linking safe.
      const emails = await getJson('https://api.github.com/user/emails', headers);
      const usable = Array.isArray(emails)
        ? emails.find((e) => e?.primary && e?.verified) || emails.find((e) => e?.verified)
        : null;

      return {
        providerUserId: String(user.id),
        email: usable?.email ? String(usable.email).toLowerCase() : '',
        emailVerified: Boolean(usable?.verified),
        usernameHint: String(user.login || ''),
        name: user.name || user.login || '',
        avatar: user.avatar_url || ''
      };
    }
  }
};

export const providerNames = Object.keys(PROVIDERS);

/** Providers with credentials present — the only ones worth rendering. */
export function availableProviders() {
  return providerNames.filter((name) => PROVIDERS[name].configured());
}

export function getProvider(name) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, name) ? PROVIDERS[name] : null;
}

export function newState() {
  return generateState();
}

/**
 * A PKCE code *verifier*.
 *
 * arctic derives the S256 challenge from the verifier itself — Google's
 * createAuthorizationURL calls createAuthorizationURLWithPKCE(S256, verifier) —
 * so the challenge must never be computed or passed in here. Handing it a
 * challenge where a verifier belongs produces a redirect that looks correct and
 * fails only at the provider, on the first real sign-in.
 */
export function newPkceVerifier() {
  return generateCodeVerifier();
}

/**
 * Turn a provider-supplied handle into something satisfying the User schema's
 * `^[a-z0-9_-]{3,24}$`, then step through `-2`, `-3`… until it is free.
 *
 * The suffix eats into the 24-character budget, so the stem is shortened to
 * make room rather than the result being allowed to overflow.
 */
export async function claimUsername(User, hint, providerUserId) {
  const stem =
    String(hint || '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || `user${String(providerUserId).slice(-8)}`;

  // Guarantee the minimum length even when the hint sanitised down to nothing.
  const base = stem.length >= 3 ? stem : `u${String(providerUserId).slice(-8).toLowerCase()}`;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
    const candidate = `${base.slice(0, 24 - suffix.length)}${suffix}`;
    const taken = await User.exists({ username: candidate });
    if (!taken) return candidate;
  }
  throw new Error('Could not allocate a username');
}

/**
 * Resolve a verified provider profile to a FlowBoard user, in priority order:
 *
 *   1. This provider identity has signed in before → that account, always.
 *   2. The provider vouched for an email that already belongs to an account →
 *      link the identity to it.
 *   3. Otherwise create a standalone account.
 *
 * Step 2 is the only path that can merge identities, and it is unreachable
 * unless the provider asserted `emailVerified`. That single field is what stops
 * someone registering an unverified `victim@example.com` at a provider and
 * inheriting the victim's boards on sign-in, so it is checked before the email
 * is even compared.
 */
export async function resolveUser(provider, profile) {
  const existing = await OAuthAccount.findOne({
    provider,
    providerUserId: profile.providerUserId
  }).lean();
  if (existing) {
    const known = await User.findById(existing.userId);
    if (known) return { user: known, linked: false, created: false };

    // The account this identity pointed at no longer exists. Without clearing
    // the stale row, creating a replacement would collide on the unique
    // (provider, providerUserId) index and throw, locking this person out of
    // the identity for good. The link is safe to drop: the user it referenced
    // is gone, so nothing is being reassigned.
    await OAuthAccount.deleteOne({ _id: existing._id });
  }

  if (profile.emailVerified && profile.email) {
    const match = await User.findOne({ email: profile.email });
    if (match) {
      await OAuthAccount.create({
        provider,
        providerUserId: profile.providerUserId,
        userId: match._id,
        email: profile.email
      });
      return { user: match, linked: true, created: false };
    }
  }

  const username = await claimUsername(User, profile.usernameHint, profile.providerUserId);
  const user = await User.create({
    username,
    // An unverified address is deliberately not stored on the account. Keeping
    // it would invite future code to treat it as trustworthy, and it is not.
    email: profile.emailVerified ? profile.email : undefined,
    emailVerified: Boolean(profile.emailVerified),
    passwordHash: '',
    avatar: profile.avatar || ''
  });
  await OAuthAccount.create({
    provider,
    providerUserId: profile.providerUserId,
    userId: user._id,
    email: profile.email || ''
  });
  return { user, linked: false, created: true };
}
