import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCMTypes,
} from "node:crypto";

// App level encryption for stored secrets (spec 0001, spec 0006 AC-7).
// Pure apart from the random IV; the keyring is always passed in. Errors
// carry fixed messages only: never the plaintext, the ciphertext, or a key.

// Key id to its 32 byte key. A Map, so no key id can collide with an
// Object.prototype name.
export type Keyring = {
  readonly activeKeyId: string;
  readonly keys: ReadonlyMap<string, Buffer>;
};

const ALGORITHM: CipherGCMTypes = "aes-256-gcm";
const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const KEY_BYTES = 32;
export const KEY_ID_PATTERN = /^[A-Za-z0-9_]{1,32}$/;

const BASE64URL = /^[A-Za-z0-9_-]*$/;

// The additional authenticated data that binds a ciphertext to its table,
// column, and row, so a value copied to another row fails to decrypt.
export const secretAad = (table: string, column: string, id: string): string =>
  `${table}.${column}:${id}`;

// v1:<keyId>:<iv>:<tag>:<ciphertext>, each part base64url, under the
// keyring's active key.
export function encryptSecret(
  keyring: Keyring,
  plaintext: string,
  aad: string,
): string {
  const key = keyring.keys.get(keyring.activeKeyId);
  // encryptionEnv() checks this; a keyring built any other way is a bug.
  if (key?.length !== KEY_BYTES) throw new Error("active key missing");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    VERSION,
    keyring.activeKeyId,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

const malformed = () => new Error("malformed secret");

// Strict base64url: Buffer.from() alone skips characters it does not know.
const decodePart = (text: string): Buffer => {
  if (!BASE64URL.test(text)) throw malformed();
  return Buffer.from(text, "base64url");
};

// Throws for a changed byte, another binding, an unknown key id, or a
// malformed value. No production caller yet (spec 0006).
export function decryptSecret(
  keyring: Keyring,
  value: string,
  aad: string,
): string {
  const parts = value.split(":");
  if (parts.length !== 5 || parts[0] !== VERSION) throw malformed();
  const [, keyId, ivText, tagText, ciphertextText] = parts;
  const key = keyring.keys.get(keyId);
  if (!key) throw new Error("unknown encryption key id");
  const iv = decodePart(ivText);
  const tag = decodePart(tagText);
  const ciphertext = decodePart(ciphertextText);
  // Node accepts a shortened GCM tag unless the length is pinned.
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw malformed();

  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("secret failed to decrypt");
  }
}

// A fresh keyring entry for `npm run secrets:keygen`: k<YYYYMMDD><4 hex>
// (the UTC date of `now`) and a random 32 byte key, base64.
export function newKeyringEntry(now: Date): {
  readonly keyId: string;
  readonly key: string;
} {
  const day = now.toISOString().slice(0, 10).replaceAll("-", "");
  return {
    keyId: `k${day}${randomBytes(2).toString("hex")}`,
    key: randomBytes(KEY_BYTES).toString("base64"),
  };
}
