import { describe, expect, it } from "vitest";
import { maskHookUrl } from "./api-keys";

// covers: spec 0021 AC-9 (the list and edit form show only the hook's host)
describe("maskHookUrl (spec 0021 AC-9)", () => {
  it("keeps the host and hides the path", () => {
    expect(maskHookUrl("https://n8n.example.test/webhook/capability123")).toBe(
      "https://n8n.example.test/…",
    );
  });

  it("keeps a port, since it is part of the host", () => {
    expect(maskHookUrl("https://hook.example.test:8443/a/b")).toBe(
      "https://hook.example.test:8443/…",
    );
  });

  it("never shows a query string or a fragment", () => {
    const shown = maskHookUrl("https://hook.example.test/p?token=abc#frag");
    expect(shown).toBe("https://hook.example.test/…");
    expect(shown).not.toMatch(/token|abc|frag/);
  });

  it("never shows credentials", () => {
    const shown = maskHookUrl("https://user:secret@hook.example.test/p");
    expect(shown).toBe("https://hook.example.test/…");
    expect(shown).not.toMatch(/user|secret/);
  });

  it("falls back to a bare mask for a value that is not a URL", () => {
    expect(maskHookUrl("not a url")).toBe("https://…");
    expect(maskHookUrl("")).toBe("https://…");
  });
});
