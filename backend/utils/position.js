const GAP = 1024;
const MIN_GAP = 1e-4;

export function firstPosition() {
  return GAP;
}

export function lastPosition() {
  return GAP;
}

export function positionBetween(before, after) {
  const hasBefore = Number.isFinite(before);
  const hasAfter = Number.isFinite(after);
  if (!hasBefore && !hasAfter) return GAP;
  if (!hasBefore) return after / 2;
  if (!hasAfter) return before + GAP;
  return (before + after) / 2;
}

export function gapIsCollapsed(before, after) {
  if (!Number.isFinite(before) || !Number.isFinite(after)) return false;
  return after - before < MIN_GAP;
}

export function spacedPositions(count) {
  return Array.from({ length: count }, (_, i) => (i + 1) * GAP);
}

export const POSITION_GAP = GAP;
export const POSITION_MIN_GAP = MIN_GAP;
