// API Keys copy shared by the page and the actions (spec 0006). Safe on
// both sides.

// What the Key value column shows for every key. A constant, never derived
// from the secret (AC-1).
export const SECRET_MASK = "••••••••••••";

export const API_KEY_MESSAGES = {
  duplicateName: "An API key with this name already exists.",
  gone: "This API key no longer exists.",
  notConfigured: "Encryption isn't configured.",
  notConfiguredPage:
    "Encryption isn't configured. Ask the owner to set up the keyring.",
  // Spec 0006 AC-12, the CLOUDFLARE key.
  cloudflareExists: "Only one Cloudflare key can exist. Edit the existing one.",
  cloudflareInvalid: "Cloudflare didn't accept this token for this account.",
  cloudflareUnavailable:
    "Couldn't reach Cloudflare to check the token. Try again.",
  cloudflareRetype: "Enter the key again to change its type or account.",
} as const;

// AC-5: an IDP key that testbeds use cannot become an AI key.
export const typeInUseMessage = (names: readonly string[]): string =>
  `Used as the IDP by: ${names.join(", ")}. Remove it from them first.`;
