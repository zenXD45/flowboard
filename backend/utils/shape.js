/**
 * The one place a User document becomes something the client sees.
 *
 * There were previously two hand-written copies of this (one in the auth
 * controller, one in the OAuth route) which had already drifted, and `requireAuth`
 * hands controllers a `.lean()` document that still carries `passwordHash`
 * because `toJSON` never runs on it. Spreading `req.user` into a response would
 * leak the hash, so every response goes through here.
 */

/** The signed-in user's own account, for /auth/me and the auth responses. */
export function publicSelf(user) {
  return {
    id: String(user._id),
    username: user.username,
    displayName: user.displayName || '',
    email: user.email || '',
    emailVerified: Boolean(user.emailVerified),
    // Distinguishes a social-only account, which has no password and therefore
    // no password-reset path, from one that can change its password.
    hasPassword: Boolean(user.passwordHash),
    avatar: user.avatar || '',
    avatarColor: user.avatarColor || '',
    theme: user.theme || 'system'
  };
}

/**
 * Another person, as shown on a board, in presence, on a card assignee or as a
 * comment/activity author. Narrower than publicSelf: no email, no settings.
 */
export function publicProfile(user) {
  return {
    id: String(user._id),
    username: user.username,
    displayName: user.displayName || '',
    avatar: user.avatar || '',
    avatarColor: user.avatarColor || ''
  };
}

/**
 * The fields a Mongo projection must keep for publicProfile/publicSelf to work.
 * Passing this to `.select()` keeps the two in step instead of listing fields by
 * hand at each call site.
 */
export const PROFILE_FIELDS = 'username displayName avatar avatarColor';
export const SELF_FIELDS = `${PROFILE_FIELDS} email emailVerified passwordHash theme`;
