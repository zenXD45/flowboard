import mongoose from 'mongoose';

const { Schema } = mongoose;

const memberSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ['owner', 'member', 'viewer'], required: true },
    addedAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

const listSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 60 },
    position: { type: Number, required: true },
    createdAt: { type: Date, default: Date.now }
  },
  { _id: true }
);

const boardSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, default: '', trim: true, maxlength: 280 },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    visibility: { type: String, enum: ['invite-only'], default: 'invite-only' },
    members: { type: [memberSchema], default: [] },
    lists: { type: [listSchema], default: [] },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  },
  { minimize: false }
);

boardSchema.index({ 'members.userId': 1, updatedAt: -1 });
boardSchema.index({ title: 'text' });

boardSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform(doc, ret) {
    ret.id = doc.id;
    delete ret._id;
    return ret;
  }
});

export const Board = mongoose.models.Board || mongoose.model('Board', boardSchema);
