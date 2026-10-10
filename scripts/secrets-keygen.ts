// Spec 0006 AC-9: prints a new keyring entry, { "<keyId>": "<base64 32
// bytes>" }, and writes nothing. Save it (or merge it into the existing
// file) at ~/secrets/hol_encryption_keys.json with mode 600, set
// APP_ENCRYPTION_ACTIVE_KEY_ID to the new id, and back the file up.
// Never remove an id while any stored value still uses it.
import { newKeyringEntry } from "@/server/crypto/secrets";

const { keyId, key } = newKeyringEntry(new Date());
console.log(JSON.stringify({ [keyId]: key }, null, 2));
console.error(`\nAPP_ENCRYPTION_ACTIVE_KEY_ID=${keyId}`);
