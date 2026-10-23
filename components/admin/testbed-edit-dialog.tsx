"use client";

import { useRef, useState } from "react";
import { CircleAlertIcon, PencilIcon } from "lucide-react";
import {
  FormDialog,
  type AdminFormAction,
} from "@/components/admin/form-dialog";
import { TestbedFields } from "@/components/admin/testbed-fields";
import type { SelectOption } from "@/components/form-select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { Result } from "@/lib/result";
import { TESTBED_MESSAGES, type TestbedEditDefaults } from "@/lib/testbeds";

type Loaded =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly defaults: TestbedEditDefaults }
  | { readonly kind: "gone" }
  | { readonly kind: "failed" };

const LOADING: Loaded = { kind: "loading" };

// Spec 0007 AC-3: a row's edit button. A ready testbed's dialog
// loads the testbed on open (the only payload with OS logins), shows a
// loading state until then, and keeps Save off until the form is there. The
// loaded values are dropped once the dialog has closed.
export function TestbedEditDialog({
  id,
  name,
  types,
  idps,
  load,
  action,
}: {
  readonly id: string;
  readonly name: string;
  readonly types: readonly SelectOption[];
  readonly idps: readonly SelectOption[];
  readonly load: (
    id: string,
  ) => Promise<Result<TestbedEditDefaults, "not_found">>;
  readonly action: AdminFormAction;
}) {
  const [loaded, setLoaded] = useState<Loaded>(LOADING);
  // Only the latest open's answer counts.
  const latest = useRef(0);

  const onOpen = () => {
    latest.current += 1;
    const request = latest.current;
    setLoaded(LOADING);
    load(id).then(
      (r) => {
        if (request !== latest.current) return;
        setLoaded(
          r.ok ? { kind: "ready", defaults: r.value } : { kind: "gone" },
        );
      },
      () => {
        if (request === latest.current) setLoaded({ kind: "failed" });
      },
    );
  };

  return (
    <FormDialog
      trigger={
        <Button variant="outline" size="icon" aria-label={`Edit ${name}`}>
          <PencilIcon aria-hidden="true" />
        </Button>
      }
      title="Edit testbed"
      action={action}
      onOpen={onOpen}
      onClosed={() => {
        latest.current += 1;
        setLoaded(LOADING);
      }}
      canSave={loaded.kind === "ready"}
    >
      <EditBody loaded={loaded} types={types} idps={idps} />
    </FormDialog>
  );
}

function EditBody({
  loaded,
  types,
  idps,
}: {
  readonly loaded: Loaded;
  readonly types: readonly SelectOption[];
  readonly idps: readonly SelectOption[];
}) {
  switch (loaded.kind) {
    case "loading":
      return (
        <div role="status" className="flex flex-col gap-4">
          <span className="sr-only">Loading the testbed…</span>
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
        <TestbedFields types={types} idps={idps} defaults={loaded.defaults} />
      );
    case "gone":
      return <LoadAlert message={TESTBED_MESSAGES.gone} />;
    case "failed":
      return <LoadAlert message="Couldn't load this testbed. Try again." />;
    default: {
      const never: never = loaded;
      return never;
    }
  }
}

function LoadAlert({ message }: { readonly message: string }) {
  return (
    <Alert variant="destructive">
      <CircleAlertIcon aria-hidden="true" />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
