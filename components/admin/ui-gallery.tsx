"use client";

import type { ReactNode } from "react";
import { PlusIcon, SearchIcon } from "lucide-react";
import type { AdminFormState } from "@/app/admin/actions";
import { DataTable, type DataTableRow } from "@/components/admin/data-table";
import { DeleteFlow } from "@/components/admin/delete-flow";
import { FormDialog } from "@/components/admin/form-dialog";
import { Field } from "@/components/field";
import { FormSelect } from "@/components/form-select";
import { notifyError, notifySuccess } from "@/components/notify";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { BADGE_TONES } from "@/lib/badge-tones";
import type {
  Blocker,
  DeleteCheck,
  DeleteKind,
  DeleteRemove,
} from "@/lib/delete-flow";
import { err, ok } from "@/lib/result";

// Every base piece with sample data (spec 0005 AC-13). The fakes below are
// browser functions, not Server Actions: nothing here touches the server.

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const OUTCOMES = [
  { value: "saved", label: "Saved" },
  { value: "fields", label: "Field errors" },
  { value: "message", label: "Message error" },
  { value: "throws", label: "Throws" },
] as const;

async function fakeSave(
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  await wait(700);
  switch (form.get("outcome")) {
    case "fields":
      return {
        kind: "error",
        fields: {
          name: "A testbed type with this name already exists.",
          durationValue: "Enter a whole number of 1 or more.",
        },
      };
    case "message":
      return {
        kind: "error",
        message: "Couldn't create the testbed's access group, try again",
        fields: {},
      };
    case "throws":
      throw new Error("gallery: thrown on purpose");
    default:
      return {
        kind: "saved",
        message: `Created ${String(form.get("name") || "Sample")}.`,
      };
  }
}

const SAMPLE_BLOCKERS: readonly Blocker[] = Array.from(
  { length: 8 },
  (_, i) => ({ id: `b${i}`, label: `Nile Workshop ${i + 1}` }),
);

const safe: DeleteCheck = async () => {
  await wait(400);
  return ok([]);
};

type FakeDelete = {
  readonly label: string;
  readonly kind: DeleteKind;
  readonly outcome: string;
  readonly check: DeleteCheck;
  readonly remove: DeleteRemove;
};

const DELETES: readonly FakeDelete[] = [
  {
    label: "Basic",
    kind: "testbed_type",
    outcome: "Blocked",
    check: async () => {
      await wait(400);
      return ok(SAMPLE_BLOCKERS);
    },
    remove: async () => ok(undefined),
  },
  {
    label: "Advanced",
    kind: "testbed_type",
    outcome: "Deleted",
    check: safe,
    remove: async () => {
      await wait(700);
      return ok(undefined);
    },
  },
  {
    label: "Okta Production",
    kind: "api_key",
    outcome: "Blocked after confirm",
    check: safe,
    remove: async () => {
      await wait(700);
      return err({ kind: "blocked", blockers: SAMPLE_BLOCKERS.slice(0, 2) });
    },
  },
  {
    label: "Nile Workshop 3",
    kind: "testbed",
    outcome: "Failed",
    check: safe,
    remove: async () => {
      await wait(700);
      return err({
        kind: "failed",
        message: "Couldn't remove the testbed's access group. Try again.",
      });
    },
  },
  {
    label: "Expert",
    kind: "testbed_type",
    outcome: "Check unavailable",
    check: async () => {
      await wait(400);
      return err("unavailable");
    },
    remove: async () => ok(undefined),
  },
  {
    label: "Bench 9",
    kind: "testbed",
    outcome: "Check throws",
    check: async () => {
      await wait(400);
      throw new Error("gallery: thrown on purpose");
    },
    remove: async () => ok(undefined),
  },
  {
    label: "Bench 10",
    kind: "testbed",
    outcome: "Delete throws",
    check: safe,
    remove: async () => {
      await wait(700);
      throw new Error("gallery: thrown on purpose");
    },
  },
];

const deleteRows: readonly DataTableRow[] = DELETES.map((d) => ({
  id: d.label,
  label: d.label,
  search: `${d.label} ${d.outcome}`,
  cells: {
    name: <span className="text-cell font-semibold text-fg1">{d.label}</span>,
    outcome: d.outcome,
  },
  actions: (
    <DeleteFlow
      kind={d.kind}
      id={d.label}
      label={d.label}
      check={d.check}
      remove={d.remove}
    />
  ),
}));

const sampleRows: readonly DataTableRow[] = [
  ["Basic", "2 hours", "Active"],
  ["Advanced", "1 day", "Active"],
  ["Retired", "4 hours", "Inactive"],
].map(([name = "", duration = "", status = ""]) => ({
  id: name,
  label: name,
  search: `${name} ${duration}`,
  cells: {
    name: <span className="text-cell font-semibold text-fg1">{name}</span>,
    duration,
    status: (
      <Badge tone={status === "Active" ? "success" : "neutral"}>{status}</Badge>
    ),
  },
}));

const sampleColumns = [
  { key: "name", header: "Type" },
  { key: "duration", header: "Duration" },
  { key: "status", header: "Status" },
] as const;

function Section({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{title}</h2>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  );
}

export function UiGallery() {
  return (
    <>
      <Section
        title="Buttons"
        description="Each variant and size. Filled actions are bold pills."
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button>Primary</Button>
          <Button variant="cta">Reserve a lab</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Delete</Button>
          <Button variant="link">Link</Button>
          <Button disabled>Disabled</Button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm">Small</Button>
          <Button>
            <PlusIcon data-icon="inline-start" aria-hidden="true" />
            Default
          </Button>
          <Button size="lg">Large</Button>
          <Button variant="outline" size="icon" aria-label="Search (icon)">
            <SearchIcon aria-hidden="true" />
          </Button>
          <Button
            variant="outline"
            size="icon-lg"
            aria-label="Search (large icon)"
          >
            <SearchIcon aria-hidden="true" />
          </Button>
        </div>
      </Section>

      <Section
        title="Badges"
        description="Status tones. Each is an AA text pair."
      >
        <div className="flex flex-wrap gap-2">
          {BADGE_TONES.map((tone) => (
            <Badge key={tone} tone={tone}>
              {tone[0]?.toUpperCase()}
              {tone.slice(1)}
            </Badge>
          ))}
        </div>
      </Section>

      <Section
        title="Inputs"
        description="Fields with labels, descriptions, and errors."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field path="sample" label="Name" description="Shown to learners.">
            <Input placeholder="e.g. Basic" />
          </Field>
          <Field
            path="sampleError"
            label="Duration"
            error="Enter a whole number of 1 or more."
          >
            <Input type="number" defaultValue={0} />
          </Field>
          <Field path="sampleSelect" label="Unit">
            <FormSelect
              name="sampleUnit"
              options={[
                { value: "hours", label: "Hours" },
                { value: "days", label: "Days" },
              ]}
              placeholder="Choose a unit"
              defaultValue="hours"
            />
          </Field>
          <Field path="sampleDisabled" label="Disabled">
            <Input disabled defaultValue="Read only value" />
          </Field>
        </div>
      </Section>

      <Section
        title="Searchable table"
        description="Filled, empty, and no match."
      >
        <DataTable
          columns={sampleColumns}
          rows={sampleRows}
          noun={{ one: "sample type", many: "sample types" }}
          searchPlaceholder="Search sample types…"
        />
        <DataTable
          columns={sampleColumns}
          rows={[]}
          noun={{ one: "empty type", many: "empty types" }}
          searchPlaceholder="Search empty types…"
        />
        <DataTable
          columns={sampleColumns}
          rows={sampleRows}
          noun={{ one: "unmatched type", many: "unmatched types" }}
          searchPlaceholder="Search unmatched types…"
          defaultQuery="zzz"
        />
      </Section>

      <Section
        title="Form modal"
        description="Pick the outcome the fake action returns, then Save."
      >
        <div>
          <FormDialog
            trigger={
              <Button>
                <PlusIcon data-icon="inline-start" aria-hidden="true" />
                Open form modal
              </Button>
            }
            title="Add sample type"
            action={fakeSave}
          >
            <Field path="name" label="Name">
              <Input name="name" placeholder="e.g. Basic" />
            </Field>
            <Field path="durationValue" label="Duration">
              <Input name="durationValue" type="number" defaultValue={1} />
            </Field>
            <Field path="outcome" label="Outcome">
              <FormSelect
                name="outcome"
                options={OUTCOMES}
                placeholder="Choose an outcome"
                defaultValue="saved"
              />
            </Field>
          </FormDialog>
        </div>
      </Section>

      <Section
        title="Delete flows"
        description="Each row's fake check and delete return the outcome named."
      >
        <DataTable
          columns={[
            { key: "name", header: "Item" },
            { key: "outcome", header: "Outcome" },
          ]}
          rows={deleteRows}
          noun={{ one: "delete sample", many: "delete samples" }}
          searchPlaceholder="Search delete samples…"
        />
      </Section>

      <Section title="Toasts" description="One region, bottom center.">
        <div className="flex flex-wrap gap-3">
          <Button
            variant="outline"
            onClick={() => notifySuccess("Created Sample.")}
          >
            Show success toast
          </Button>
          <Button
            variant="outline"
            onClick={() => notifyError("Couldn't save the change. Try again.")}
          >
            Show error toast
          </Button>
        </div>
      </Section>
    </>
  );
}
