import mongoose from 'mongoose';

const { Schema } = mongoose;

const commentSchema = new Schema(
  {
    boardId: { type: Schema.Types.ObjectId, ref: 'Board', required: true, index: true },
    cardId: { type: Schema.Types.ObjectId, ref: 'Card', required: true, index: true },
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    body: { type: String, required: true, trim: true, maxlength: 2000 },
    createdAt: { type: Date, default: Date.now }
  },
  { minimize: false }
);

commentSchema.index({ cardId: 1, createdAt: 1 });

commentSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform(doc, ret) {
    ret.id = doc.id;
    delete ret._id;
    return ret;
  }
});

export const Comment = mongoose.models.Comment || mongoose.model('Comment', commentSchema);
