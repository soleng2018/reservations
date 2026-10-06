// Testbed slugs: lowercase words joined by single hyphens, at most 50
// characters (matches the testbeds_slug_format CHECK). Set once at create.
export const SLUG_MAX = 50;

const trimHyphens = (s: string) => s.replace(/^-+|-+$/g, "");

export function slugify(name: string): string {
  const slug = trimHyphens(
    trimHyphens(
      name
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-"),
    ).slice(0, SLUG_MAX),
  );
  return slug === "" ? "testbed" : slug;
}

// The candidate for collision attempt `n` (1 is the base itself, then -2, -3,
// …). The base is cut so the suffixed slug still fits in SLUG_MAX.
export function slugCandidate(base: string, n: number): string {
  if (n <= 1) return base;
  const suffix = `-${n}`;
  return `${trimHyphens(base.slice(0, SLUG_MAX - suffix.length))}${suffix}`;
}
