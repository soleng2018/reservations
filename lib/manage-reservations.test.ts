import { describe, expect, it } from "vitest";
import type { BookingStatus } from "./db-enums";
import {
  cardActions,
  firstName,
  preferFirst,
  sortCards,
  zoneName,
} from "./manage-reservations";

const now = new Date("2026-10-12T12:00:00Z");
const row = (
  id: string,
  status: BookingStatus,
  starts: string,
  ends: string,
) => ({
  id,
  status,
  startsAt: new Date(starts),
  endsAt: new Date(ends),
});

// covers: AC-1
describe("firstName", () => {
  it.each([
    ["Ada Lovelace", "Ada"],
    ["  Ada   Lovelace  ", "Ada"],
    ["Ada", "Ada"],
    ["", ""],
  ])("%j gives %j", (name, first) => {
    expect(firstName(name)).toBe(first);
  });
});

// covers: AC-1
describe("zoneName", () => {
  it("shows the zone with spaces and no offset", () => {
    expect(zoneName("America/New_York")).toBe("America/New York");
    expect(zoneName("UTC")).toBe("UTC");
  });
});

// covers: AC-1
describe("sortCards", () => {
  it("puts Current first, Upcoming soonest first, then Past latest first", () => {
    const rows = [
      row("p1", "completed", "2026-10-01T09:00:00Z", "2026-10-01T11:00:00Z"),
      row("u2", "confirmed", "2026-10-20T09:00:00Z", "2026-10-20T11:00:00Z"),
      row("p2", "confirmed", "2026-10-11T09:00:00Z", "2026-10-11T11:00:00Z"),
      row("c1", "confirmed", "2026-10-12T11:00:00Z", "2026-10-12T13:00:00Z"),
      row("u1", "confirmed", "2026-10-14T09:00:00Z", "2026-10-14T11:00:00Z"),
    ];
    const sorted = sortCards(rows, now);
    expect(sorted.map((r) => r.id)).toEqual(["c1", "u1", "u2", "p2", "p1"]);
    expect(sorted.map((r) => r.phase)).toEqual([
      "Current",
      "Upcoming",
      "Upcoming",
      "Past",
      "Past",
    ]);
  });

  it("orders equal starts by id and leaves the input alone", () => {
    const rows = [
      row("b", "completed", "2026-10-01T09:00:00Z", "2026-10-01T11:00:00Z"),
      row("a", "completed", "2026-10-01T09:00:00Z", "2026-10-01T11:00:00Z"),
    ];
    expect(sortCards(rows, now).map((r) => r.id)).toEqual(["a", "b"]);
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
  });
});

// covers: AC-1, AC-6
describe("cardActions", () => {
  it.each(["Upcoming", "Current"] as const)(
    "%s offers Reschedule and Cancel when reschedulable",
    (phase) => {
      expect(cardActions(phase, true)).toEqual({
        reschedule: true,
        cancel: true,
        cannotReschedule: false,
      });
      expect(cardActions(phase, false)).toEqual({
        reschedule: false,
        cancel: true,
        cannotReschedule: true,
      });
    },
  );

  it.each(["Past", "Pending", "Cancelled"] as const)(
    "%s has no action",
    (phase) => {
      expect(cardActions(phase, true)).toEqual({
        reschedule: false,
        cancel: false,
        cannotReschedule: false,
      });
    },
  );
});

// covers: AC-9
describe("preferFirst", () => {
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("moves the preferred one first and keeps the rest in order", () => {
    expect(preferFirst(list, "c").map((t) => t.id)).toEqual(["c", "a", "b"]);
    expect(preferFirst(list, "a").map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("ignores a preferred id that is not a candidate", () => {
    expect(preferFirst(list, "z")).toEqual(list);
  });
});
