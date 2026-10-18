import "server-only";
import { err, ok, type Result } from "@/lib/result";
import {
  calendarPath,
  classifyStatus,
  googleRequest,
  type GoogleCallError,
  type GoogleFetch,
} from "./http";

// Spec 0013 AC-19: the shared calendar's events, written as the sender
// mailbox. No attendees and sendUpdates=none, so nobody is mailed. Reply
// bodies are never read or stored.

export type CalendarEvent = {
  readonly summary: string;
  readonly description: string;
  readonly start: Date;
  readonly end: Date;
};

const eventBody = (event: CalendarEvent) => ({
  summary: event.summary,
  description: event.description,
  start: { dateTime: event.start.toISOString(), timeZone: "UTC" },
  end: { dateTime: event.end.toISOString(), timeZone: "UTC" },
});

const eventsUrl = (calendarId: string, eventId?: string) =>
  `${calendarPath(calendarId)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ""}?sendUpdates=none`;

type Call = {
  readonly fetch: GoogleFetch;
  readonly token: string;
  readonly calendarId: string;
  readonly eventId: string;
};

const send = async (
  c: Call,
  method: "PUT" | "POST" | "DELETE",
  url: string,
  body?: unknown,
): Promise<Result<number, GoogleCallError>> => {
  const reply = await googleRequest(c.fetch, url, {
    method,
    token: c.token,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  if (!reply.ok) return err("retry");
  await reply.value.body?.cancel();
  return ok(reply.value.status);
};

const is2xx = (status: number) => status >= 200 && status < 300;

// Update in place; "missing" when the event does not exist yet.
export async function putEvent(
  c: Call,
  event: CalendarEvent,
): Promise<Result<"updated" | "missing", GoogleCallError>> {
  const r = await send(
    c,
    "PUT",
    eventsUrl(c.calendarId, c.eventId),
    eventBody(event),
  );
  if (!r.ok) return r;
  if (is2xx(r.value)) return ok("updated");
  return r.value === 404 ? ok("missing") : err(classifyStatus(r.value));
}

// Insert with our own id; "exists" when a concurrent run created it (409).
export async function insertEvent(
  c: Call,
  event: CalendarEvent,
): Promise<Result<"inserted" | "exists", GoogleCallError>> {
  const r = await send(c, "POST", eventsUrl(c.calendarId), {
    id: c.eventId,
    ...eventBody(event),
  });
  if (!r.ok) return r;
  if (is2xx(r.value)) return ok("inserted");
  return r.value === 409 ? ok("exists") : err(classifyStatus(r.value));
}

// 404 and 410 mean it is already gone.
export async function deleteEvent(
  c: Call,
): Promise<Result<void, GoogleCallError>> {
  const r = await send(c, "DELETE", eventsUrl(c.calendarId, c.eventId));
  if (!r.ok) return r;
  if (is2xx(r.value) || r.value === 404 || r.value === 410)
    return ok(undefined);
  return err(classifyStatus(r.value));
}
