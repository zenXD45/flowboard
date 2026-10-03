/**
 * Connection strings carry a password, and this app logs its configuration on
 * boot so an operator can confirm at a glance which database it reached. Log
 * aggregation and hosted dashboards keep those lines long after they are
 * written, so the credential is stripped before the string is ever emitted.
 *
 * The split is done on the *last* `@` rather than the first because a
 * generated MongoDB password may legitimately contain an unencoded `@`, and
 * truncating at the first one would leave part of the password in the log.
 */

export function redactMongoUrl(url) {
  const value = String(url ?? '');

  const schemeEnd = value.indexOf('://');
  if (schemeEnd === -1) return value;

  const scheme = value.slice(0, schemeEnd + 3);
  const rest = value.slice(schemeEnd + 3);

  const at = rest.lastIndexOf('@');
  if (at === -1) return value;

  const credentials = rest.slice(0, at);
  const colon = credentials.indexOf(':');
  if (colon === -1) return value;

  return `${scheme}${credentials.slice(0, colon)}:***@${rest.slice(at + 1)}`;
}
