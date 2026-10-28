import "server-only";
import type { Result } from "@/lib/result";

// What the interpreter sees of a portal (spec 0023 "The portal interface"):
// one call, a typed result, nothing else. The real client and the in memory
// fake both satisfy it. A body goes straight into the pure helpers and is
// dropped; only ids, labels, picked scalars, and a redacted message leave.
export type PortalRequest = {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly body?: unknown;
};

export type PortalReply = { readonly status: number; readonly body: unknown };

export type CallError = "network" | "timeout" | "redirect" | "oversize";

export type PortalClient = {
  readonly call: (
    req: PortalRequest,
  ) => Promise<Result<PortalReply, CallError>>;
  readonly close: () => Promise<void>;
};
