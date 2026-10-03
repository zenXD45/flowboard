export const ROLES = ['owner', 'member', 'viewer'];

export function roleFor(board, userId) {
  if (!board || !userId) return null;
  const id = String(userId);
  const entry = board.members?.find((m) => String(m.userId) === id);
  if (entry) return entry.role;
  if (String(board.ownerId) === id) return 'owner';
  return null;
}

export function canView(role) {
  return role === 'owner' || role === 'member' || role === 'viewer';
}

export function canEdit(role) {
  return role === 'owner' || role === 'member';
}

export function canManage(role) {
  return role === 'owner';
}

export function publicMember(board) {
  return {
    id: String(board._id),
    title: board.title,
    ownerId: String(board.ownerId),
    visibility: board.visibility,
    members: (board.members || []).map((m) => ({
      userId: String(m.userId),
      role: m.role,
      addedAt: m.addedAt
    })),
    lists: (board.lists || []).map((l) => ({
      id: String(l._id),
      title: l.title,
      position: l.position,
      createdAt: l.createdAt
    })),
    createdAt: board.createdAt,
    updatedAt: board.updatedAt
  };
}

export function ensureMemberPayload(board, userId) {
  const role = roleFor(board, userId);
  return { board, role };
}
