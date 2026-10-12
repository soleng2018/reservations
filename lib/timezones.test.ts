import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDateTime } from "./format-time";
import {
  browserTimeZone,
  currentZoneName,
  isTimeZone,
  Timezone,
  timezoneOptions,
  zoneLabel,
} from "./timezones";

// covers: AC-3, AC-4 (timezone parse), AC-6 (display)
describe("timezones (AC-3, AC-4)", () => {
  it("accepts real zones and aliases, refuses anything else", () => {
    expect(isTimeZone("America/New_York")).toBe(true);
    expect(isTimeZone("Asia/Calcutta")).toBe(true);
    expect(isTimeZone("UTC")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
    expect(isTimeZone("")).toBe(false);
    expect(Timezone.safeParse(" Europe/Paris ").data).toBe("Europe/Paris");
    expect(Timezone.safeParse("Not/AZone").success).toBe(false);
  });

  it("lists every zone plus UTC and the browser's alias, once each, sorted", () => {
    const list = timezoneOptions("Asia/Calcutta");
    expect(list).toContain("UTC");
    expect(list).toContain("Asia/Kolkata");
    expect(new Set(list).size).toBe(list.length);
    expect([...list].sort()).toEqual(list);
    expect(timezoneOptions("bogus")).not.toContain("bogus");
  });

  // spec 0010 AC-1: ICU's old names would hide "kolkata" or "kyiv".
  it("uses current IANA names, not ICU's old ones", () => {
    const list = timezoneOptions("UTC");
    for (const current of [
      "Asia/Kolkata",
      "Asia/Kathmandu",
      "Europe/Kyiv",
      "Asia/Ho_Chi_Minh",
    ])
      expect(list).toContain(current);
    for (const old of ["Asia/Calcutta", "Asia/Katmandu", "Europe/Kiev"])
      expect(list).not.toContain(old);
    expect(currentZoneName("Asia/Calcutta")).toBe("Asia/Kolkata");
    expect(currentZoneName("America/New_York")).toBe("America/New_York");
    expect(list.every(isTimeZone)).toBe(true);
  });
});

// covers: spec 0010 AC-1, AC-7
describe("zoneLabel", () => {
  const summer = new Date("2026-07-01T12:00:00Z");
  const winter = new Date("2026-12-01T12:00:00Z");

  it("shows the zone with spaces and its offset at that instant", () => {
    expect(zoneLabel("America/New_York", summer)).toBe(
      "America/New York (GMT-4)",
    );
    expect(zoneLabel("America/New_York", winter)).toBe(
      "America/New York (GMT-5)",
    );
    expect(zoneLabel("Asia/Kathmandu", summer)).toBe(
      "Asia/Kathmandu (GMT+5:45)",
    );
  });

  it("shows UTC and a zero offset as GMT", () => {
    expect(zoneLabel("UTC", summer)).toBe("UTC (GMT)");
    expect(zoneLabel("Europe/London", winter)).toBe("Europe/London (GMT)");
  });
});

// covers: spec 0010 AC-1 (the preselected zone)
describe("browserTimeZone (AC-1)", () => {
  const browserZone = (timeZone: string | undefined) => {
    const real = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(
      Intl.DateTimeFormat.prototype,
      "resolvedOptions",
    ).mockImplementation(function (this: Intl.DateTimeFormat) {
      return {
        ...real.call(this),
        timeZone,
      } as Intl.ResolvedDateTimeFormatOptions;
    });
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("presets the browser's zone", () => {
    browserZone("America/New_York");
    expect(browserTimeZone()).toBe("America/New_York");
  });

  it("names an old alias by its current name", () => {
    browserZone("Asia/Calcutta");
    expect(browserTimeZone()).toBe("Asia/Kolkata");
  });

  it.each([undefined, "", "Mars/Olympus"])(
    "falls back to UTC when the zone is %o",
    (zone) => {
      browserZone(zone);
      expect(browserTimeZone()).toBe("UTC");
    },
  );

  it("falls back to UTC when Intl throws", () => {
    vi.spyOn(
      Intl.DateTimeFormat.prototype,
      "resolvedOptions",
    ).mockImplementation(() => {
      throw new RangeError("no zone");
    });
    expect(browserTimeZone()).toBe("UTC");
  });
});

describe("formatDateTime with a zone (AC-6)", () => {
  it("formats a time with its zone", () => {
    expect(
      formatDateTime(new Date("2026-10-13T13:00:00Z"), "America/New_York"),
    ).toBe("Tue, Oct 13, 2026, 9:00 AM EDT");
  });
});
