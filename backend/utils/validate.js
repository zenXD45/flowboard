export function cleanString(value, max, { required = false, fallback = '' } = {}) {
  if (value === undefined || value === null) {
    return required ? { error: 'This field is required' } : { value: fallback };
  }
  if (typeof value !== 'string') return { error: 'Expected a string' };
  const trimmed = value.trim();
  if (required && trimmed.length === 0) return { error: 'This field is required' };
  if (trimmed.length > max) return { error: `Must be ${max} characters or fewer` };
  return { value: trimmed };
}

export function cleanLabels(value) {
  if (value === undefined || value === null) return { value: [] };
  if (!Array.isArray(value)) return { error: 'labels must be an array' };
  if (value.length > 8) return { error: 'A card can have at most 8 labels' };
  const out = [];
  for (const raw of value) {
    if (typeof raw !== 'string') return { error: 'Each label must be a string' };
    const label = raw.trim().toLowerCase();
    if (!label) continue;
    if (label.length > 24) return { error: 'Labels must be 24 characters or fewer' };
    if (!/^[a-z0-9 _-]+$/.test(label)) {
      return { error: 'Labels may only contain letters, numbers, spaces, _ and -' };
    }
    if (!out.includes(label)) out.push(label);
  }
  return { value: out };
}

export function cleanIndex(value, fallback = 0) {
  if (value === undefined || value === null) return { value: fallback };
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return { error: 'index must be a non-negative number' };
  return { value: Math.floor(n) };
}

export function cleanVersion(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    return { error: 'expectedVersion must be the integer version you last saw' };
  }
  return { value: n };
}

export function cleanDate(value) {
  if (value === undefined || value === null || value === '') return { value: null };
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { error: 'dueDate is not a valid date' };
  return { value: d };
}
