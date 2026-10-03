import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: /^[a-z0-9_-]{3,24}$/
    },
    // Cosmetic only. `username` stays the identity every board, membership and
    // activity row references, so changing this can never break an invite.
    displayName: { type: String, default: '', trim: true, maxlength: 40 },
    email: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
    // Whether the provider vouched for this address. Only a verified address
    // is allowed to link a social identity to an existing account.
    emailVerified: { type: Boolean, default: false },
    // Absent for accounts that only ever signed in socially. Such an account
    // cannot use password login, which is also why password reset is a
    // provider concern rather than a local one.
    passwordHash: { type: String, default: '' },
    // The URL rendered as the avatar. Either an https address (the provider's,
    // or one the user pasted) or the short path /users/<id>/avatar when an
    // upload exists. Kept as a short string on purpose: every board snapshot
    // carries this field, so an inlined data URL here would ship the image on
    // every member, assignee and comment payload.
    avatar: { type: String, default: '' },
    // Index into the frontend's avatar palette, or '' to derive one from the id.
    avatarColor: { type: String, default: '' },
    // The uploaded image itself, as a data URL. Deliberately separate from
    // `avatar` so the lightweight projections that select `username avatar`
    // never load it.
    avatarUpload: { type: String, default: '' },
    theme: { type: String, enum: ['system', 'dark', 'light'], default: 'system' },
    createdAt: { type: Date, default: Date.now }
  },
  { minimize: false }
);

userSchema.index({ username: 'text' });

userSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform(doc, ret) {
    ret.id = doc.id;
    delete ret._id;
    delete ret.passwordHash;
    // The raw image is served from /users/:id/avatar; serialising it here would
    // inline the whole data URL anywhere a document is returned directly.
    delete ret.avatarUpload;
    return ret;
  }
});

export const User = mongoose.models.User || mongoose.model('User', userSchema);
