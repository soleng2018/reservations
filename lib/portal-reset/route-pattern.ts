// A route as the engine records it (spec 0023 AC-25, AC-36): the query is
// dropped and every segment that looks like an id becomes `{id}`, so a record
// or an audit row never holds a resolved URL. A segment is an id when it is a
// uuid, only digits, or a long token that mixes letters and digits (a tenant
// prefixed id). Placeholders already in the text stay. Safe on both sides.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const looksLikeId = (segment: string): boolean =>
  UUID.test(segment) ||
  /^\d+$/.test(segment) ||
  (segment.length >= 8 && /\d/.test(segment) && /[a-z]/i.test(segment));

export function routePattern(path: string): string {
  const base = path.split(/[?#]/)[0] ?? path;
  return base
    .split("/")
    .map((segment) => (looksLikeId(segment) ? "{id}" : segment))
    .join("/");
}
