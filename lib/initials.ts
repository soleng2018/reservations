// The avatar letters of a name (spec 0008 AC-2): the first letters of its
// first and last words, uppercased. One word gives one letter. Pure.
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0];
  const last = words.length > 1 ? words.at(-1) : undefined;
  return [first, last]
    .flatMap((w) => (w ? [w.charAt(0)] : []))
    .join("")
    .toUpperCase();
}

// The account menu avatar (spec 0005 AC-17): always two letters, so a one
// word name repeats its letter ("John" is "JJ"), and a blank name is "?".
export function initialsOf(name: string): string {
  const letters = initials(name);
  if (letters === "") return "?";
  return letters.length === 1 ? `${letters}${letters}` : letters;
}
