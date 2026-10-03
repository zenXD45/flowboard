import mongoose from 'mongoose';

/**
 * A social identity, kept separate from User.
 *
 * One person may hold Google and GitHub on a single FlowBoard account, and one
 * provider identity may belong to exactly one account — enforced by the
 * compound unique index below rather than by application code, so a race
 * between two simultaneous callbacks cannot create a second owner.
 *
 * User stays the single source of truth for `username`, which every board,
 * membership and activity entry references.
 */
const oauthAccountSchema = new mongoose.Schema(
  {
    provider: {
      type: String,
      required: true,
      enum: ['google', 'github'],
      index: true
    },
    providerUserId: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    email: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now }
  },
  { versionKey: false }
);

oauthAccountSchema.index({ provider: 1, providerUserId: 1 }, { unique: true });

export const OAuthAccount =
  mongoose.models.OAuthAccount || mongoose.model('OAuthAccount', oauthAccountSchema);
