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
  // Spec 0013 AC-1 to AC-4, the GOOGLE key.
  googleExists: "Only one Google key can exist. Edit the existing one.",
  keyFileMissing: "Choose the key file.",
  keyFileTooLarge: "The key file is too large.",
  keyFileInvalid: "This isn't a Google service account key file (.json).",
  googleUnavailable: "Couldn't reach Google to check the key. Try again.",
  googleFileRequired:
    "Upload the key file again to change the sender, calendar, or type.",
  keyRequired: "Enter the key again to change its type.",
} as const;

// Spec 0013 AC-1: the most a key file may be. Google's are about 2.4 KB.
export const MAX_KEY_FILE_BYTES = 16 * 1024;

// Spec 0013 AC-2, the save check's answers that name the sender.
export const googleDelegationMessage = (sender: string, clientId: string) =>
  `Google refused this key for ${sender}. In the Google Admin console, add client ID ${clientId} under domain wide delegation with the gmail.send and calendar.events scopes.`;

export const googleInvalidMessage = (sender: string) =>
  `Google didn't accept this key for ${sender}. Check that the key still exists in Google Cloud and that ${sender} is a user in your Workspace domain.`;

export const googleCalendarMessage = (sender: string) =>
  `${sender} can't open this calendar. Create it in that mailbox or share it with "Make changes to events".`;

// AC-5: an IDP key that testbeds use cannot become an AI key.
export const typeInUseMessage = (names: readonly string[]): string =>
  `Used as the IDP by: ${names.join(", ")}. Remove it from them first.`;
