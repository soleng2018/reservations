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
  // Spec 0013 AC-25 to AC-29 (amended 2026-10-16), Google sign in.
  keyFileOAuth:
    "This is an OAuth client file. Choose Google sign in as the sign in method, or use a service account key.",
  clientFileMissing: "Choose the OAuth client file.",
  clientFileTooLarge: "The OAuth client file is too large.",
  clientFileWeb:
    "This is a Web application client. Create a Desktop app OAuth client in Google Cloud and use its file.",
  clientFileServiceAccount:
    "This is a service account key. Choose Service account as the sign in method, or use an OAuth client file.",
  clientFileInvalid: "This isn't a Google OAuth client file (.json).",
  signInMissing: "Sign in with Google first, then paste the address.",
  signInIncomplete: "Paste the full address from the page Google opened.",
  signInCancelled: "The Google sign in was cancelled. Sign in again.",
  signInFailed: "Google didn't finish the sign in. Sign in again.",
  signInExpired:
    "This sign in expired or belongs to another attempt. Sign in with Google again.",
  signInRefused:
    "Google didn't accept this sign in (it may have been used already). Sign in with Google again.",
  clientInvalid:
    "Google didn't accept this OAuth client. Check the file, or create a new Desktop app client.",
  noRefresh:
    "Google didn't return a lasting sign in. Sign in with Google again.",
  scopes:
    "Allow both sending email and Calendar events on the Google screen, then sign in with Google again.",
  noEmail:
    "Google didn't share a verified email for this account. Sign in with Google again.",
  signInRequired: "Sign in with Google again to change the calendar.",
  signInSwitch: "Sign in with Google to switch to Google sign in.",
  fileSwitch: "Upload the key file to switch to Service account.",
} as const;

// Spec 0013 AC-28 step 8: after a spent code, the AC-2 answers also say to
// start over.
export const signInAgain = (message: string) =>
  `${message} Then sign in with Google again.`;

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
