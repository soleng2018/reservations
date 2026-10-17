import "server-only";

// Test support for spec 0013 AC-15: reads a built MIME message the way a mail
// client walks it, so tests can pin the part tree and read the invite.

// A part's content type (lowercased, without parameters), its parameters,
// disposition, Content-ID, and children or decoded body.
export type MimePart = {
  readonly type: string;
  readonly params: Readonly<Record<string, string>>;
  readonly disposition: string | null;
  readonly contentId: string | null;
  readonly children: readonly MimePart[];
  readonly body: string;
};

const headerValue = (headers: string, name: string): string | null => {
  const unfolded = headers.replace(/\r?\n[ \t]+/g, " ");
  const line = unfolded
    .split(/\r?\n/)
    .find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line ? line.slice(name.length + 1).trim() : null;
};

export function parseMime(raw: string): MimePart {
  const split = raw.search(/\r?\n\r?\n/);
  const headers = raw.slice(0, split);
  const rest = raw.slice(split).replace(/^\r?\n\r?\n/, "");
  const [type = "", ...rawParams] = (
    headerValue(headers, "Content-Type") ?? "text/plain"
  ).split(";");
  const params = Object.fromEntries(
    rawParams.map((p) => {
      const [k = "", ...v] = p.trim().split("=");
      return [k.toLowerCase(), v.join("=").replace(/^"|"$/g, "")];
    }),
  );
  const boundary = params.boundary;
  const children = boundary
    ? rest
        .split(`--${boundary}`)
        .slice(1, -1)
        .map((p) => parseMime(p.replace(/^\r?\n/, "")))
    : [];
  const encoding = headerValue(headers, "Content-Transfer-Encoding");
  return {
    type: type.trim().toLowerCase(),
    params,
    disposition: headerValue(headers, "Content-Disposition"),
    contentId: headerValue(headers, "Content-ID"),
    children,
    body:
      encoding?.toLowerCase() === "base64"
        ? Buffer.from(rest.replace(/\s+/g, ""), "base64").toString("utf8")
        : rest,
  };
}

// Every part, depth first.
export const allParts = (p: MimePart): readonly MimePart[] => [
  p,
  ...p.children.flatMap(allParts),
];

// Content types nested as a client walks them.
export type MimeShape = string | readonly [string, readonly MimeShape[]];
export const mimeShape = (p: MimePart): MimeShape =>
  p.children.length ? [p.type, p.children.map(mimeShape)] : p.type;

// The one text/calendar part, decoded, with its method parameter.
export function inviteOf(raw: string): {
  readonly method: string | undefined;
  readonly ics: string;
} {
  const parts = allParts(parseMime(raw)).filter(
    (p) => p.type === "text/calendar",
  );
  const [invite] = parts;
  if (parts.length !== 1 || !invite)
    throw new Error(`expected one text/calendar part, found ${parts.length}`);
  return { method: invite.params.method, ics: invite.body };
}
