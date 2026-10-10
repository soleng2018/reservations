import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Spec 0005 AC-1: every text pair in the Nile tokens passes WCAG AA 4.5:1,
// and every control boundary 3:1. Values are read from app/globals.css:
// `--color-*` from the plain @theme block, shadcn variables from :root
// (var() aliases skipped), and the two CTA stops from @utility bg-nile-cta.
const css = readFileSync(path.resolve(__dirname, "../app/globals.css"), "utf8");

const WHITE = "#ffffff";

// The body of the first block whose header matches (blocks hold no braces).
const block = (source: string, header: RegExp): string => {
  const m = header.exec(source);
  if (!m) throw new Error(`no block ${header}`);
  const start = m.index + m[0].length;
  return source.slice(start, source.indexOf("}", start));
};

const hexes = (body: string): ReadonlyMap<string, string> =>
  new Map(
    [...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map(
      (m) => [m[1] ?? "", (m[2] ?? "").toLowerCase()] as const,
    ),
  );

type Tokens = {
  readonly theme: ReadonlyMap<string, string>;
  readonly root: ReadonlyMap<string, string>;
  readonly cta: readonly string[];
};

const tokens = (source: string): Tokens => ({
  theme: hexes(block(source, /@theme\s*\{/)),
  root: hexes(block(source, /:root\s*\{/)),
  cta: [
    ...block(source, /@utility bg-nile-cta\s*\{/).matchAll(/#[0-9a-f]{6}/gi),
  ].map((m) => m[0].toLowerCase()),
});

const channel = (v: number) =>
  v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) =>
    channel(parseInt(hex.slice(i, i + 2), 16) / 255),
  );
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
};

const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
};

type Pair = {
  readonly name: string;
  readonly fg: string;
  readonly bg: string;
  readonly min: number;
};

// The *Contrast pairs* table in spec 0005.
const pairs = (t: Tokens): readonly Pair[] => {
  const c = (name: string) =>
    t.theme.get(`color-${name}`) ?? `missing --color-${name}`;
  const v = (name: string) => t.root.get(name) ?? `missing --${name}`;
  const on = (
    name: string,
    fg: string,
    bgs: readonly (readonly [string, string])[],
    min = 4.5,
  ) =>
    bgs.map(([bgName, bg]) => ({ name: `${name} on ${bgName}`, fg, bg, min }));
  const white = ["white", WHITE] as const;
  const mist = ["cloud-mist", c("cloud-mist")] as const;
  const inset = ["bg-inset", c("bg-inset")] as const;
  return [
    ...on("fg1", c("fg1"), [white, mist]),
    ...on("fg2", c("fg2"), [white, mist, inset]),
    ...on("fg3", c("fg3"), [white, mist, inset]),
    ...on("white", WHITE, [["nile-blue", c("nile-blue")]]),
    ...on("white", WHITE, [["danger-strong", c("danger-strong")]]),
    ...on(
      "white",
      WHITE,
      t.cta.map((stop, i) => [`bg-nile-cta stop ${i + 1}`, stop] as const),
    ),
    ...on("nile-blue", c("nile-blue"), [["nile-blue-100", c("nile-blue-100")]]),
    ...on("success-fg", c("success-fg"), [["teal-100", c("teal-100")]]),
    ...on("violet-fg", c("violet-fg"), [["violet-100", c("violet-100")]]),
    ...on("sidebar-foreground", v("sidebar-foreground"), [
      ["nile-ink", c("nile-ink")],
    ]),
    ...on("input", v("input"), [white], 3),
    ...on("ring", v("ring"), [white], 3),
  ];
};

const failures = (source: string): readonly string[] =>
  pairs(tokens(source))
    .filter((p) => !(ratio(p.fg, p.bg) >= p.min))
    .map((p) => `${p.name}: ${ratio(p.fg, p.bg).toFixed(3)} < ${p.min}`);

describe("Nile token contrast", () => {
  it("resolves every token the pairs need", () => {
    const t = tokens(css);
    const all = pairs(t).flatMap((p) => [p.fg, p.bg]);
    expect(all.filter((x) => !/^#[0-9a-f]{6}$/.test(x))).toEqual([]);
    expect(t.cta).toHaveLength(2);
  });

  it("passes AA for every text pair and 3:1 for every boundary", () => {
    expect(failures(css)).toEqual([]);
  });

  it("fails when fg3 goes back to the mock's #6B8295", () => {
    const reverted = css.replace(
      /--color-fg3:\s*#[0-9a-f]{6}/i,
      "--color-fg3: #6b8295",
    );
    expect(failures(reverted)).toContain("fg3 on white: 3.998 < 4.5");
  });
});
