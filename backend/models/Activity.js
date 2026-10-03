import mongoose from 'mongoose';

const { Schema } = mongoose;

const activitySchema = new Schema(
  {
    boardId: { type: Schema.Types.ObjectId, ref: 'Board', required: true, index: true },
    actorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    verb: {
      type: String,
      enum: [
        'board.created',
        'board.updated',
        'member.added',
        'member.removed',
        'member.role',
        'list.created',
        'list.renamed',
        'list.moved',
        'list.deleted',
        'card.created',
        'card.moved',
        'card.updated',
        'card.assigned',
        'card.deleted',
        'comment.added'
      ],
      required: true
    },
    targetType: { type: String, enum: ['board', 'list', 'card'], default: 'board' },
    targetId: { type: String, default: '' },
    meta: { type: Schema.Types.Mixed, default: {} },
    createdAt: { type: Date, default: Date.now }
  },
  { minimize: false }
);

activitySchema.index({ boardId: 1, createdAt: -1 });
activitySchema.index({ boardId: 1, _id: -1 });

export const Activity = mongoose.models.Activity || mongoose.model('Activity', activitySchema);

export async function recordActivity(entry) {
  try {
    return await Activity.create(entry);
  } catch {
    // Activity is a side-channel; never fail the user's mutation because of it.
    return null;
  }
}
