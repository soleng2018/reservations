import type { Cond, Part, Rule, StepDefinition } from "./step-schema";

// A plain words description of a step, one short sentence per part
// (spec 0022 AC-24). Pure. It names paths and fields only, never a value
// read from a portal. Safe on both sides.
const show = (value: unknown): string =>
  typeof value === "string"
    ? JSON.stringify(value)
    : (JSON.stringify(value) ?? "?");

type Test = {
  readonly op: Rule["op"];
  readonly value?: unknown;
};

const phrase = (subject: string, test: Test): string => {
  switch (test.op) {
    case "eq":
      return `${subject} is ${show(test.value)}`;
    case "ne":
      return `${subject} is not ${show(test.value)}`;
    case "in":
      return `${subject} is one of ${
        Array.isArray(test.value) ? test.value.map(show).join(", ") : "?"
      }`;
    case "exists":
      return `${subject} is set`;
    case "missing":
      return `${subject} is not set`;
    case "nonEmpty":
      return `${subject} is not empty`;
    default: {
      const unreachable: never = test.op;
      throw new Error(`Unhandled operator ${String(unreachable)}`);
    }
  }
};

const rules = (items: readonly Rule[]): string =>
  items.map((r) => phrase(r.field, r)).join(" and ");

const conds = (items: readonly Cond[] | undefined): string =>
  items === undefined || items.length === 0
    ? ""
    : `, only when ${items.map((c) => phrase(`${c.read}.${c.key}`, c)).join(" and ")}`;

const refusals = (part: {
  readonly expectRefusals?: readonly { readonly status: number }[];
}): string =>
  part.expectRefusals === undefined
    ? ""
    : `, expecting the portal to refuse some with ${[
        ...new Set(part.expectRefusals.map((r) => r.status)),
      ].join(" or ")}`;

function describePart(part: Part): string {
  switch (part.kind) {
    case "read":
      return `Read ${part.method} ${part.path} and keep ${Object.keys(part.pick).join(", ")} as ${part.as}${conds(part.when)}.`;
    case "delete_each": {
      const how =
        part.delete.batch === true
          ? `delete all the items in one call with DELETE ${part.delete.path}`
          : `delete each item with DELETE ${part.delete.path}`;
      const nested =
        part.list.nested === undefined
          ? ""
          : ` (the items inside each record, in ${part.list.nested.at})`;
      const only =
        part.onlyWhen === undefined
          ? ""
          : `, only items where ${rules(part.onlyWhen)}`;
      const skip =
        part.skipWhen === undefined
          ? ""
          : `, skipping items where ${rules(part.skipWhen)}`;
      return `Read ${part.list.method} ${part.list.path}${nested}, ${how}${only}${skip}${refusals(part)}${conds(part.when)}.`;
    }
    case "call":
      return `Call ${part.method} ${part.path}${part.body === undefined ? "" : " with a body"}${refusals(part)}${conds(part.when)}.`;
    case "update_record":
      return `Read ${part.list.method} ${part.list.path}, and in each record where ${rules(part.match)} set ${part.set.at} to ${show(part.set.value)} and PUT it back to ${part.put.path}${conds(part.when)}.`;
    case "wait":
      return `Wait ${part.seconds} ${part.seconds === 1 ? "second" : "seconds"}${conds(part.when)}.`;
    case "expect":
      return `Check that ${phrase(`${part.read}.${part.key}`, part)}${conds(part.when)}.`;
    default: {
      const unreachable: never = part;
      throw new Error(`Unhandled part ${JSON.stringify(unreachable)}`);
    }
  }
}

export const describeStep = (definition: StepDefinition): readonly string[] =>
  definition.parts.map(describePart);
