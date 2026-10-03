/**
 * Mirrors the server's fractional-position maths so an optimistic drag lands in
 * the right visual slot immediately, before the server tells us the real value.
 * Duplicate values are fine: the authoritative echo overwrites them a few
 * hundred milliseconds later.
 */
export function positionBetween(before, after) {
  const hasBefore = Number.isFinite(before);
  const hasAfter = Number.isFinite(after);
  if (!hasBefore && !hasAfter) return 1024;
  if (!hasBefore) return after / 2;
  if (!hasAfter) return before + 1024;
  return (before + after) / 2;
}

export function sortByPosition(cards) {
  return [...cards].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

export function groupByList(cards) {
  const grouped = new Map();
  for (const card of cards) {
    if (!grouped.has(card.listId)) grouped.set(card.listId, []);
    grouped.get(card.listId).push(card);
  }
  for (const [listId, list] of grouped) grouped.set(listId, sortByPosition(list));
  return grouped;
}
