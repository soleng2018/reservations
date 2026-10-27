"use client";

import { useRef, useState, type ReactElement } from "react";
import { CircleAlertIcon } from "lucide-react";
import {
  FormDialog,
  type AdminFormAction,
} from "@/components/admin/form-dialog";
import { TestbedFields } from "@/components/admin/testbed-fields";
import type { SelectOption } from "@/components/form-select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import type { Result } from "@/lib/result";
import { TESTBED_MESSAGES, type GroupChoice } from "@/lib/testbeds";

type Loaded =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly choices: readonly GroupChoice[] }
  | { readonly kind: "unavailable" };

const LOADING: Loaded = { kind: "loading" };

// Spec 0017 AC-18: the add dialog reads the group list when it opens, shows a
// loading state with Save off, and drops the list once the dialog has closed.
// Unavailable or empty leaves the select disabled and Save off.
export function TestbedAddDialog({
  trigger,
  types,
  idps,
  load,
  action,
}: {
  readonly trigger: ReactElement;
  readonly types: readonly SelectOption[];
  readonly idps: readonly SelectOption[];
  readonly load: () => Promise<Result<readonly GroupChoice[], "unavailable">>;
  readonly action: AdminFormAction;
}) {
  const [loaded, setLoaded] = useState<Loaded>(LOADING);
  // AC-22: Save stays off until the chosen group has a domain.
  const [groupDomain, setGroupDomain] = useState<string | null>(null);
  // Only the latest open's answer counts.
  const latest = useRef(0);

  const onOpen = () => {
    latest.current += 1;
    const request = latest.current;
    setLoaded(LOADING);
    setGroupDomain(null);
    load().then(
      (r) => {
        if (request !== latest.current) return;
        setLoaded(
          r.ok ? { kind: "ready", choices: r.value } : { kind: "unavailable" },
        );
      },
      () => {
        if (request === latest.current) setLoaded({ kind: "unavailable" });
      },
    );
  };

  return (
    <FormDialog
      trigger={trigger}
      title="Add testbed"
      action={action}
      onOpen={onOpen}
      onClosed={() => {
        latest.current += 1;
        setLoaded(LOADING);
        setGroupDomain(null);
      }}
      canSave={
        loaded.kind === "ready" &&
        loaded.choices.length > 0 &&
        groupDomain !== null
      }
    >
      <AddBody
        loaded={loaded}
        types={types}
        idps={idps}
        onGroupDomain={setGroupDomain}
      />
    </FormDialog>
  );
}

function AddBody({
  loaded,
  types,
  idps,
  onGroupDomain,
}: {
  readonly loaded: Loaded;
  readonly types: readonly SelectOption[];
  readonly idps: readonly SelectOption[];
  readonly onGroupDomain: (domain: string | null) => void;
}) {
  switch (loaded.kind) {
    case "loading":
      return (
        <div role="status" className="flex flex-col gap-4">
          <span className="sr-only">Loading the Authentik groups…</span>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex flex-col gap-2" aria-hidden="true">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-11 w-full" />
            </div>
          ))}
        </div>
      );
    case "ready":
      return (
        <TestbedFields
          types={types}
          idps={idps}
          groupChoices={loaded.choices}
          onGroupDomain={onGroupDomain}
          groupNotice={
            loaded.choices.length === 0
              ? TESTBED_MESSAGES.groupChoicesEmpty
              : undefined
          }
        />
      );
    case "unavailable":
      return (
        <>
          <Alert variant="destructive">
            <CircleAlertIcon aria-hidden="true" />
            <AlertDescription>
              {TESTBED_MESSAGES.groupChoicesUnavailable}
            </AlertDescription>
          </Alert>
          <TestbedFields types={types} idps={idps} groupChoices={[]} />
        </>
      );
    default: {
      const never: never = loaded;
      return never;
    }
  }
}
