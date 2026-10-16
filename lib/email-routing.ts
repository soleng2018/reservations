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

// Case is ignored throughout.
export function isTestAddress(address: string): boolean {
  const lower = address.trim().toLowerCase();
  const at = lower.lastIndexOf("@");
  const local = at < 0 ? lower : lower.slice(0, at);
  const domain = at < 0 ? "" : lower.slice(at + 1);
  return (
    TEST_LOCAL_PREFIXES.some((p) => local.startsWith(p)) ||
    TEST_DOMAIN_SUFFIXES.some((s) => domain.endsWith(s)) ||
    TEST_DOMAINS.some((d) => domain === d)
  );
}

export type EmailRouting = {
  readonly devInbox: string | null;
  readonly opsBcc: string | null;
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

export function routeEmail(
  toAddress: string,
  { devInbox, opsBcc }: EmailRouting,
): EmailRoute {
  if (!isTestAddress(toAddress))
    return { kind: "send", to: toAddress, bcc: opsBcc, subjectPrefix: "" };
  if (devInbox === null)
    return { kind: "suppress", reason: SUPPRESSED_NO_DEV_INBOX };
  return { kind: "send", to: devInbox, bcc: null, subjectPrefix: "[dev] " };
}
