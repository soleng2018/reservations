import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fieldErrors } from "./form-errors";

const Form = z.object({
  name: z.string().min(1, "Enter a name.").max(3, "Too long."),
  clients: z.array(z.object({ url: z.string().min(1, "Enter a URL.") })),
});

const errorsFor = (input: unknown) => {
  const r = Form.safeParse(input);
  if (r.success) throw new Error("expected the input to be refused");
  return fieldErrors(r.error);
};

describe("fieldErrors", () => {
  it("keys nested issues by their dotted path", () => {
    expect(
      errorsFor({ name: "ok", clients: [{ url: "x" }, { url: "" }] }),
    ).toEqual({ "clients.1.url": "Enter a URL." });
  });

  it("keeps only the first message for a field", () => {
    const Twice = z.object({
      name: z.string().min(5, "First.").regex(/^\d+$/, "Second."),
    });
    const r = Twice.safeParse({ name: "ab" });
    if (r.success) throw new Error("expected the input to be refused");
    expect(r.error.issues).toHaveLength(2);
    expect(fieldErrors(r.error)).toEqual({ name: "First." });
  });

  it("keys a whole object issue by the empty path", () => {
    const r = Form.safeParse("not an object");
    if (r.success) throw new Error("expected the input to be refused");
    expect(Object.keys(fieldErrors(r.error))).toEqual([""]);
  });

  it("returns one entry per failing field", () => {
    expect(
      Object.keys(errorsFor({ name: "", clients: [{ url: "" }] })),
    ).toEqual(["name", "clients.0.url"]);
  });
});
