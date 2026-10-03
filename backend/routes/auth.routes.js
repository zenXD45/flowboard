import express from 'express';
import config from '../config/index.js';
import { User } from '../models/User.js';
import { signToken } from '../utils/token.js';
import {
  PROVIDERS,
  availableProviders,
  getProvider,
  newState,
  newPkceVerifier,
  resolveUser
} from '../utils/oauth.js';

/**
 * Social sign-in.
 *
 * The JWT is deliberately never placed in the redirect URL. A token in
 * `?token=` leaks into browser history, into the Referer header of any request
 * the landing page makes, and into whatever logs sit in front of the frontend.
 * Instead the callback hands back a single-use code, which the browser
 * immediately exchanges over POST for the same JWT the password path returns.
 *
 * In-memory stores are used for `state` and the exchange code. That is the same
 * single-instance assumption the in-memory Socket.io adapter already makes: a
 * second Render instance would need these moved to Redis alongside it.
 */

const STATE_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;
const MAX_PENDING = 10_000;

const pendingStates = new Map();
const exchangeCodes = new Map();

/** Drop expired entries, and hard-cap the map so a flood cannot grow it forever. */
function sweep(store, now = Date.now()) {
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key);
  }
  while (store.size > MAX_PENDING) {
    store.delete(store.keys().next().value);
  }
}

function issueCode(userId) {
  sweep(exchangeCodes);
  const code = newState();
  exchangeCodes.set(code, { userId: String(userId), expiresAt: Date.now() + CODE_TTL_MS });
  return code;
}

function shape(user) {
  return {
    id: String(user._id),
    username: user.username,
    email: user.email || '',
    avatar: user.avatar || ''
  };
}

export function authRoutes() {
  const router = express.Router();

  // Which providers can be offered right now, so the UI never renders a
  // button for a provider whose credentials are missing.
  router.get('/providers', (_req, res) => {
    res.json({
      providers: availableProviders().map((name) => ({ id: name, label: PROVIDERS[name].label }))
    });
  });

  router.get('/:provider', (req, res) => {
    const provider = getProvider(req.params.provider);
    if (!provider) return res.status(404).json({ error: 'Unknown provider' });
    if (!provider.configured()) {
      return res.status(503).json({ error: `${provider.label} sign-in is not configured` });
    }
    if (!config.publicUrl) {
      return res.status(503).json({ error: 'PUBLIC_URL is not set on the server' });
    }

    sweep(pendingStates);
    const state = newState();
    // Only providers that advertise PKCE get a verifier; it is echoed back on
    // exchange and never leaves the server.
    const codeVerifier = provider.pkce ? newPkceVerifier() : null;
    pendingStates.set(state, {
      provider: req.params.provider,
      codeVerifier,
      expiresAt: Date.now() + STATE_TTL_MS
    });

    res.redirect(302, provider.authorizeUrl(provider.client(), state, codeVerifier));
  });

  router.get('/:provider/callback', async (req, res) => {
    const provider = getProvider(req.params.provider);
    if (!provider || !provider.configured()) {
      return res.redirect(302, `${config.frontendUrl}/#auth=failed`);
    }
    if (req.query.error) {
      return res.redirect(302, `${config.frontendUrl}/#auth=cancelled`);
    }

    const state = String(req.query.state || '');
    const code = String(req.query.code || '');
    const entry = pendingStates.get(state);

    // Single use: consumed whether or not it was valid, so a replayed callback
    // cannot reuse it and a wrong guess cannot probe further.
    pendingStates.delete(state);
    if (!entry || entry.provider !== req.params.provider) {
      return res.redirect(302, `${config.frontendUrl}/#auth=invalid-state`);
    }
    if (!code) return res.redirect(302, `${config.frontendUrl}/#auth=failed`);

    try {
      const tokens = await provider.exchange(provider.client(), code, entry.codeVerifier);
      const profile = await provider.profile(tokens);
      if (!profile.providerUserId) throw new Error('provider returned no id');

      const { user, created } = await resolveUser(req.params.provider, profile);
      if (!user) throw new Error('account could not be resolved');

      if (created) console.log(`[oauth] ${req.params.provider} created account ${user.username}`);

      // The code travels in the fragment, which browsers never send to a
      // server and never place in a Referer header.
      const handoff = issueCode(user._id);
      res.redirect(302, `${config.frontendUrl}/#code=${encodeURIComponent(handoff)}`);
    } catch (err) {
      console.error(`[oauth] ${req.params.provider} callback failed:`, err.message);
      res.redirect(302, `${config.frontendUrl}/#auth=failed`);
    }
  });

  router.post('/exchange', (req, res) => {
    const code = String(req.body?.code || '');
    const entry = exchangeCodes.get(code);
    exchangeCodes.delete(code);
    if (!entry || entry.expiresAt <= Date.now()) {
      return res.status(400).json({ error: 'That sign-in link has expired. Please try again.' });
    }
    User.findById(entry.userId)
      .then((user) => {
        if (!user) return res.status(400).json({ error: 'Account no longer exists' });
        res.json({ token: signToken(user._id), user: shape(user) });
      })
      .catch(() => res.status(500).json({ error: 'Could not complete sign-in' }));
  });

  return router;
}
