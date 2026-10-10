// The searchable table's filter (spec 0005 AC-6). A row matches when the
// trimmed query is a case insensitive substring of its search text; an
// empty query matches everything.
export const matchesQuery = (search: string, query: string): boolean => {
  const q = query.trim().toLowerCase();
  return q === "" || search.toLowerCase().includes(q);
};

export const filterRows = <T extends { readonly search: string }>(
  rows: readonly T[],
  query: string,
): readonly T[] => rows.filter((r) => matchesQuery(r.search, query));

// What the live region says after each change.
export const resultCount = (n: number): string =>
  n === 0 ? "No results" : n === 1 ? "1 result" : `${n} results`;
