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
    email: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    avatar: { type: String, default: '' },
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
    return ret;
  }
});

export const User = mongoose.models.User || mongoose.model('User', userSchema);
