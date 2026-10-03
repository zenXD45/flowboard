import mongoose from 'mongoose';

const { Schema } = mongoose;

const cardSchema = new Schema(
  {
    boardId: { type: Schema.Types.ObjectId, ref: 'Board', required: true, index: true },
    listId: { type: Schema.Types.ObjectId, required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 140 },
    description: { type: String, default: '', trim: true, maxlength: 4000 },
    position: { type: Number, required: true },
    assigneeId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    dueDate: { type: Date, default: null },
    labels: { type: [String], default: [] },
    version: { type: Number, default: 1 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  },
  { minimize: false }
);

cardSchema.index({ boardId: 1, listId: 1, position: 1 });
cardSchema.index({ boardId: 1, updatedAt: -1 });

cardSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform(doc, ret) {
    ret.id = doc.id;
    delete ret._id;
    return ret;
  }
});

export const Card = mongoose.models.Card || mongoose.model('Card', cardSchema);
