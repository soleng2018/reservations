import type { BookingPhase } from "./booking-phase";
import type { TestbedClientKind } from "./db-enums";

// A booking's lab links and how each screen shows them (spec 0012). Safe on
// both sides: the links themselves only ever come from `ownLabAccess`.

export type LabLinks = {
  // Spec 0019 AC-6: the learner's Nile login for this booking's domain, or
  // null (a booking made before spec 0019 has none).
  readonly nileLogin?: string | null;
  readonly portalUrl: string;
  readonly lmsUrl: string;
  readonly clients: readonly {
    readonly name: string;
    readonly kind: TestbedClientKind;
    readonly url: string;
  }[];
};

export type LabAccessDetail = {
  readonly testbedName: string;
  readonly typeName: string;
  readonly status: "confirmed" | "completed";
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly links: LabLinks;
};

// One row of the lab access card: "Nile Portal", "LMS course", or a client
// with its kind. An ended row carries no URL at all (AC-8).
export type LabRow = {
  readonly label: string;
  readonly kind: TestbedClientKind | null;
};

export type LabLinkRow = LabRow & { readonly url: string };

export type LabCardRows =
  | { readonly kind: "active"; readonly rows: readonly LabLinkRow[] }
  | { readonly kind: "ended"; readonly rows: readonly LabRow[] };

// The portal and the LMS first, then each client in the given order.
export const labRows = (links: LabLinks): readonly LabLinkRow[] => [
  { label: "Nile Portal", kind: null, url: links.portalUrl },
  { label: "LMS course", kind: null, url: links.lmsUrl },
  ...links.clients.map((c) => ({ label: c.name, kind: c.kind, url: c.url })),
];

// Labels and kinds only, so a Past booking's URLs never leave the server.
export const endedRows = (links: LabLinks): readonly LabRow[] =>
  labRows(links).map(({ label, kind }) => ({ label, kind }));

const START_NOTE =
  "These links start working at your start time (allow up to a minute).";
const SUPPORT_NOTE = "Quote the testbed name below if you contact support.";

// The success screens' note (AC-2, AC-5): a booked or rescheduled start is
// always at least an hour ahead, so it is the Upcoming one.
export const SUCCESS_NOTE = START_NOTE;

export type LabAccessView = {
  readonly note: string;
  readonly active: boolean; // false: "Ended" tags in place of the links
};

// The detail page's note and link state by phase (AC-7, AC-8). Lab access
// exists only for confirmed and completed bookings, so Pending and Cancelled
// are a broken invariant. The Current note asks for the tabs to be closed,
// because the end of a booking refuses new requests but doesn't close an
// open VM tab (AC-10).
export function labAccessView(phase: BookingPhase): LabAccessView {
  switch (phase) {
    case "Current":
      return {
        note: `${SUPPORT_NOTE} Access can take up to a minute to start after your start time. Close your lab tabs when your time ends.`,
        active: true,
      };
    case "Upcoming":
      return { note: `${START_NOTE} ${SUPPORT_NOTE}`, active: true };
    case "Past":
      return {
        note: `This reservation has ended and access is no longer active. ${SUPPORT_NOTE}`,
        active: false,
      };
    case "Pending":
    case "Cancelled":
      throw new Error(`no lab access for a ${phase} booking`);
    default: {
      const never: never = phase;
      throw new Error(`unknown booking phase: ${String(never)}`);
    }
  }
}

// What the card gets for a phase: links while active, labels once ended.
export const labCardRows = (
  links: LabLinks,
  view: LabAccessView,
): LabCardRows =>
  view.active
    ? { kind: "active", rows: labRows(links) }
    : { kind: "ended", rows: endedRows(links) };
