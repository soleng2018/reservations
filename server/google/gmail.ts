import "server-only";
import { z } from "zod";
import { err, ok, type Result } from "@/lib/result";
import {
  classifyStatus,
  googleRequest,
  type GoogleCallError,
  type GoogleFetch,
} from "./http";

// Spec 0013 AC-15: send one raw MIME message as the token's mailbox. A
// timeout or network error is a retry; the reply body is never stored.

const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

const Sent = z.object({ id: z.string().min(1) });

export async function sendRaw(
  fetchFn: GoogleFetch,
  token: string,
  raw: string,
): Promise<Result<{ readonly id: string }, GoogleCallError>> {
  const reply = await googleRequest(fetchFn, SEND_URL, {
    method: "POST",
    token,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (!reply.ok) return err("retry");
  const res = reply.value;
  if (res.status < 200 || res.status >= 300) {
    await res.body?.cancel();
    return err(classifyStatus(res.status));
  }
  const body = Sent.safeParse(await res.json().catch(() => undefined));
  // A 2xx without a readable id: Gmail most likely accepted it, so a retry
  // could send it twice. It fails instead, and the email row says why.
  return body.success
    ? ok({ id: body.data.id })
    : err({ kind: "final", status: res.status });
}
