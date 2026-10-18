// Spec 0013 AC-16: where a learner email really goes. Dev and Playwright
// bookings use test addresses, so they never reach an outside party. Pure,
// safe on both sides.

const TEST_LOCAL_PREFIXES = ["dev-", "hol-test-"] as const;
const TEST_DOMAIN_SUFFIXES = [
  ".test",
  ".invalid",
  ".example",
  ".localhost",
] as const;
const TEST_DOMAINS = ["example.com", "example.net", "example.org"] as const;

// Trimmed, lowercased, split at the last "@".
function addressParts(address: string): {
  readonly local: string;
  readonly domain: string;
} {
  const lower = address.trim().toLowerCase();
  const at = lower.lastIndexOf("@");
  return at < 0
    ? { local: lower, domain: "" }
    : { local: lower.slice(0, at), domain: lower.slice(at + 1) };
}

// Case is ignored throughout.
export function isTestAddress(address: string): boolean {
  const { local, domain } = addressParts(address);
  return (
    TEST_LOCAL_PREFIXES.some((p) => local.startsWith(p)) ||
    TEST_DOMAIN_SUFFIXES.some((s) => domain.endsWith(s)) ||
    TEST_DOMAINS.some((d) => domain === d)
  );
}

const GMAIL_DOMAINS = ["gmail.com", "googlemail.com"] as const;

// The mailbox an address delivers to, as far as the address alone shows: a
// "+" tag is dropped, and Gmail ignores dots and treats googlemail.com as
// gmail.com.
function mailboxKey(address: string): string {
  const { local, domain } = addressParts(address);
  const plus = local.indexOf("+");
  const untagged = plus < 0 ? local : local.slice(0, plus);
  const gmail = GMAIL_DOMAINS.some((d) => d === domain);
  return gmail
    ? `${untagged.replaceAll(".", "")}@gmail.com`
    : `${untagged}@${domain}`;
}

// Spec 0013 AC-35: best effort. Workspace aliases and groups, catch alls, and
// other providers' tag separators can't be seen from the address.
export function sameMailbox(a: string, b: string): boolean {
  return mailboxKey(a) === mailboxKey(b);
}

export type EmailRouting = {
  readonly devInbox: string | null;
  readonly opsBcc: string | null;
  readonly senderEmail: string;
};

export type EmailRoute =
  | {
      readonly kind: "send";
      readonly to: string;
      readonly bcc: string | null;
      // "[dev] " for a rerouted test address, else "".
      readonly subjectPrefix: string;
    }
  | { readonly kind: "suppress"; readonly reason: string };

export const SUPPRESSED_NO_DEV_INBOX = "Test address and no dev inbox is set.";
export const SUPPRESSED_DEV_INBOX_IS_SENDER =
  "The dev inbox is the sender's own mailbox.";

// Spec 0013 AC-36: neither inbox is ever the sender's own mailbox, so a key
// saved before AC-35 can't put a learner's invite in the organizer's calendar.
// A learner whose own address is the sender's is left alone (operator only).
export function routeEmail(
  toAddress: string,
  { devInbox, opsBcc, senderEmail }: EmailRouting,
): EmailRoute {
  if (!isTestAddress(toAddress)) {
    const bcc =
      opsBcc === null || sameMailbox(opsBcc, senderEmail) ? null : opsBcc;
    return { kind: "send", to: toAddress, bcc, subjectPrefix: "" };
  }
  if (devInbox === null)
    return { kind: "suppress", reason: SUPPRESSED_NO_DEV_INBOX };
  if (sameMailbox(devInbox, senderEmail))
    return { kind: "suppress", reason: SUPPRESSED_DEV_INBOX_IS_SENDER };
  return { kind: "send", to: devInbox, bcc: null, subjectPrefix: "[dev] " };
}
