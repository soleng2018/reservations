import "server-only";
import { err, ok, type Result } from "@/lib/result";

// An expected refusal raised inside a transaction, so the transaction rolls
// back every write, then returned as a Result once it has (spec 0008 lock
// first pattern). Anything else thrown is a bug and passes through.
export class Refusal<E> extends Error {
  constructor(readonly code: E) {
    super(String(code));
  }
}

export async function refusable<T, E>(
  run: () => Promise<T>,
): Promise<Result<T, E>> {
  try {
    return ok(await run());
  } catch (e) {
    // The code's type is the caller's E: only `run` throws Refusal<E>.
    if (e instanceof Refusal) return err(e.code as E);
    throw e;
  }
}
