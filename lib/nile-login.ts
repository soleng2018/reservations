// Spec 0019 AC-1, AC-2: a learner's Nile login for a testbed domain, built
// from their stored name. Pure: the random numbers are an argument.

const PART_MAX = 30;
const LOCAL_MAX = 64; // the whole username before the `@`
const FALLBACK_LOCAL = "learner";
export const NUMBER_MIN = 1000;
export const NUMBER_MAX = 9999;
export const DRAW_COUNT = 5;

// Lowercase, accents removed (decompose, drop the marks), only a to z and
// 0 to 9, cut to 30 characters.
export function cleanPart(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, PART_MAX);
}

const words = (name: string): readonly string[] =>
  name.split(/\s+/).filter((w) => w !== "");

// The first and last word of the stored name, as Authentik's `firstName` and
// `lastName` (AC-4). A single word has no last name.
export function nameWords(name: string): {
  readonly first: string;
  readonly last: string | null;
} {
  const all = words(name);
  const first = all[0] ?? "";
  const last = all.length > 1 ? (all[all.length - 1] ?? null) : null;
  return { first, last };
}

// The name part before the `@`: `first.last`, `first`, the email's local part
// when the first name cleans to nothing, or `learner` as a last resort.
// `plain` is false for `learner`, which always gets a number (AC-1).
export function localPart(
  name: string,
  email: string,
): { readonly local: string; readonly plain: boolean } {
  const { first, last } = nameWords(name);
  const cleanFirst = cleanPart(first);
  if (cleanFirst !== "") {
    const cleanLast = last === null ? "" : cleanPart(last);
    return {
      local: cleanLast === "" ? cleanFirst : `${cleanFirst}.${cleanLast}`,
      plain: true,
    };
  }
  const fromEmail = cleanPart(email.split("@")[0] ?? "");
  return fromEmail === ""
    ? { local: FALLBACK_LOCAL, plain: false }
    : { local: fromEmail, plain: true };
}

// The local part with a number added, cut so the whole stays within 64.
const numbered = (local: string, n: number): string => {
  const digits = String(n);
  return `${local.slice(0, LOCAL_MAX - digits.length)}${digits}`;
};

// The logins to try, in order: the plain address (unless the name part is
// the `learner` fallback), then one per drawn number. Duplicates drop out.
export function nileLoginCandidates(
  input: {
    readonly name: string;
    readonly email: string;
    readonly domain: string;
  },
  draws: readonly number[],
): readonly string[] {
  const { local, plain } = localPart(input.name, input.email);
  const logins = [
    ...(plain ? [local] : []),
    ...draws.map((n) => numbered(local, n)),
  ].map((l) => `${l}@${input.domain.toLowerCase()}`);
  return logins.filter((l, i) => logins.indexOf(l) === i);
}

// `count` distinct whole numbers from 1000 to 9999. `next` yields a number
// from 0 up to but not including its argument (Math.random scaled, or
// crypto.randomInt); a function argument so tests can fix it.
export function drawNumbers(
  count: number,
  next: (below: number) => number,
): readonly number[] {
  const span = NUMBER_MAX - NUMBER_MIN + 1;
  const pick = (have: readonly number[]): readonly number[] => {
    if (have.length >= count) return have;
    const n = NUMBER_MIN + next(span);
    return pick(have.includes(n) ? have : [...have, n]);
  };
  return pick([]);
}
