import { describe, expect, it } from "vitest";
import { parseMime } from "./testing";

const message = (encoding: string, body: string) =>
  `Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: ${encoding}\r\n\r\n${body}`;

// The test reader decodes a body the way a mail client does, so an assertion
// on text never depends on where the encoder wrapped a line (spec 0029 found
// "priya.=<CRLF>raman" splitting a match).
describe("parseMime bodies", () => {
  it("joins a quoted printable soft line break", () => {
    const part = parseMime(
      message("quoted-printable", "Nile login  priya.=\r\nraman@t.test"),
    );
    expect(part.body).toBe("Nile login  priya.raman@t.test");
  });

  it("decodes =XX bytes, including a multi byte UTF-8 character", () => {
    const part = parseMime(
      message("quoted-printable", "Nile =C2=B7 nilesecure.com =3D ok"),
    );
    expect(part.body).toBe("Nile · nilesecure.com = ok");
  });

  it("is case insensitive about the encoding name and the hex digits", () => {
    const part = parseMime(message("Quoted-Printable", "a=c2=a9b"));
    expect(part.body).toBe("a©b");
  });

  it("decodes base64 and leaves 7bit bodies as they are", () => {
    expect(
      parseMime(message("base64", Buffer.from("héllo").toString("base64")))
        .body,
    ).toBe("héllo");
    expect(parseMime(message("7bit", "plain =3D text")).body).toBe(
      "plain =3D text",
    );
  });
});
