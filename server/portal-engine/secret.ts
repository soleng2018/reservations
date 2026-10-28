import "server-only";
import { inspect } from "node:util";

// A value that must never reach a log, a row, a job, or an email (spec 0023
// AC-30): the password and the three sign in headers. Printing, JSON, and
// Node's inspect all give "[redacted]"; only `reveal` returns the value.
export type Secret<T> = {
  readonly reveal: () => T;
  readonly toString: () => string;
  readonly toJSON: () => string;
};

const REDACTED = "[redacted]";

export function secret<T>(value: T): Secret<T> {
  const shown = () => REDACTED;
  const box = {
    reveal: () => value,
    toString: shown,
    toJSON: shown,
  };
  Object.defineProperty(box, inspect.custom, { value: shown });
  Object.defineProperty(box, "reveal", { enumerable: false });
  return Object.freeze(box);
}
