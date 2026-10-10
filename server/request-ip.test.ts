import { describe, expect, it } from "vitest";
import { clientIp } from "./request-ip";

// covers: AC-4 (the IP bucket key)
describe("clientIp", () => {
  const headers = new Headers({ "cf-connecting-ip": " 203.0.113.9 " });

  it("trusts CF-Connecting-IP only behind the tunnel", () => {
    expect(clientIp(headers, true)).toBe("203.0.113.9");
    expect(clientIp(headers, false)).toBe("untrusted");
  });

  it("falls back to the shared bucket without the header", () => {
    expect(clientIp(new Headers(), true)).toBe("untrusted");
  });
});
