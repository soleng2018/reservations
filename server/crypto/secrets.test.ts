import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  KEY_ID_PATTERN,
  newKeyringEntry,
  secretAad,
  type Keyring,
} from "./secrets";

// Spec 0006 AC-7: AES-256-GCM bound to its row, with a rotatable keyring.

const keyring = (activeKeyId = "k1", ids = ["k1"]): Keyring => ({
  activeKeyId,
  keys: new Map(ids.map((id) => [id, randomBytes(32)])),
});

const ROW = "6f1c2a52-6d0c-4f1e-9a51-3f0f1a2b3c4d";
const AAD = secretAad("api_keys", "secret_ciphertext", ROW);

// Flips one bit of a decoded part, then encodes it again: changing the last
// base64url character can decode to the same bytes.
const flip = (value: string, part: 2 | 3 | 4): string => {
  const parts = value.split(":");
  const bytes = Buffer.from(parts[part], "base64url");
  bytes[0] ^= 1;
  return parts.with(part, bytes.toString("base64url")).join(":");
};

const replacePart = (value: string, part: number, text: string) =>
  value.split(":").with(part, text).join(":");

describe("secretAad", () => {
  it("binds table, column, and row", () => {
    expect(AAD).toBe(`api_keys.secret_ciphertext:${ROW}`);
  });
});

describe("encryptSecret and decryptSecret", () => {
  const ring = keyring();

  it("round trips, in the v1 format", () => {
    const value = encryptSecret(ring, "tok_ünïcode secret", AAD);
    expect(value).toMatch(
      /^v1:k1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]+$/,
    );
    expect(decryptSecret(ring, value, AAD)).toBe("tok_ünïcode secret");
  });

  it("never holds the plaintext", () => {
    const value = encryptSecret(ring, "canary-plaintext", AAD);
    expect(value).not.toContain("canary");
    expect(value).not.toContain(Buffer.from("canary").toString("base64url"));
  });

  it("uses a fresh IV each time", () => {
    expect(encryptSecret(ring, "same", AAD)).not.toBe(
      encryptSecret(ring, "same", AAD),
    );
  });

  it.each([2, 3, 4] as const)("throws when decoded part %i changes", (part) => {
    const value = encryptSecret(ring, "secret", AAD);
    expect(() => decryptSecret(ring, flip(value, part), AAD)).toThrow();
  });

  it("throws for another row, column, or table", () => {
    const value = encryptSecret(ring, "secret", AAD);
    const other = crypto.randomUUID();
    expect(() =>
      decryptSecret(
        ring,
        value,
        secretAad("api_keys", "secret_ciphertext", other),
      ),
    ).toThrow();
    expect(() =>
      decryptSecret(ring, value, secretAad("api_keys", "name", ROW)),
    ).toThrow();
    expect(() =>
      decryptSecret(
        ring,
        value,
        secretAad("testbeds", "secret_ciphertext", ROW),
      ),
    ).toThrow();
  });

  it("throws for a truncated tag", () => {
    const value = encryptSecret(ring, "secret", AAD);
    const tag = Buffer.from(value.split(":")[3], "base64url");
    const short = replacePart(
      value,
      3,
      tag.subarray(0, 12).toString("base64url"),
    );
    expect(() => decryptSecret(ring, short, AAD)).toThrow("malformed secret");
  });

  it("throws for an 11 byte IV", () => {
    const value = encryptSecret(ring, "secret", AAD);
    const iv = Buffer.from(value.split(":")[2], "base64url");
    const short = replacePart(
      value,
      2,
      iv.subarray(0, 11).toString("base64url"),
    );
    expect(() => decryptSecret(ring, short, AAD)).toThrow("malformed secret");
  });

  it("throws for an unknown key id", () => {
    const value = encryptSecret(ring, "secret", AAD);
    expect(() => decryptSecret(ring, replacePart(value, 1, "k9"), AAD)).toThrow(
      "unknown encryption key id",
    );
  });

  it.each([
    ["plain text", "my-secret"],
    ["another version", "v2:k1:a:b:c"],
    ["too few parts", "v1:k1:a:b"],
    ["too many parts", "v1:k1:a:b:c:d"],
    ["non base64url characters", "v1:k1:AAAA+AAAAAAAAAAA:b:c"],
  ])("throws for a malformed value (%s)", (_, value) => {
    expect(() => decryptSecret(ring, value, AAD)).toThrow();
  });

  it("never puts the plaintext or ciphertext in an error", () => {
    const value = encryptSecret(ring, "canary-plaintext", AAD);
    const tampered = flip(value, 4);
    const message = (() => {
      try {
        decryptSecret(ring, tampered, AAD);
        return "";
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    })();
    expect(message).toBe("secret failed to decrypt");
  });

  it("still decrypts an old value after the active key moves", () => {
    const old = keyring("k1", ["k1"]);
    const value = encryptSecret(old, "secret", AAD);
    const rotated: Keyring = {
      activeKeyId: "k2",
      keys: new Map([...old.keys, ["k2", randomBytes(32)]]),
    };
    expect(decryptSecret(rotated, value, AAD)).toBe("secret");
    const fresh = encryptSecret(rotated, "secret", AAD);
    expect(fresh.split(":")[1]).toBe("k2");
    expect(decryptSecret(rotated, fresh, AAD)).toBe("secret");
  });

  it("refuses to encrypt without a 32 byte active key", () => {
    expect(() => encryptSecret(keyring("k2", ["k1"]), "s", AAD)).toThrow();
    const short: Keyring = {
      activeKeyId: "k1",
      keys: new Map([["k1", randomBytes(31)]]),
    };
    expect(() => encryptSecret(short, "s", AAD)).toThrow();
  });
});

describe("newKeyringEntry", () => {
  it("makes a dated key id and a random 32 byte key", () => {
    const entry = newKeyringEntry(new Date("2026-10-10T23:30:00Z"));
    expect(entry.keyId).toMatch(/^k20261010[0-9a-f]{4}$/);
    expect(entry.keyId).toMatch(KEY_ID_PATTERN);
    expect(Buffer.from(entry.key, "base64")).toHaveLength(32);
    expect(newKeyringEntry(new Date()).key).not.toBe(entry.key);
  });
});
