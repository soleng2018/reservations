"use client";

import { useReducer, useRef, useState, type ReactElement } from "react";
import { CircleAlertIcon } from "lucide-react";
import {
  FormDialog,
  type AdminFormAction,
} from "@/components/admin/form-dialog";
import { TestbedFields } from "@/components/admin/testbed-fields";
import type { SelectOption } from "@/components/form-select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CHOICES_CLOSED,
  choicesReducer,
  groupNoticeKey,
  type Loaded,
} from "@/lib/group-choices-state";
import type { Result } from "@/lib/result";
import { TESTBED_MESSAGES, type GroupChoice } from "@/lib/testbeds";

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
  const [{ loaded }, dispatch] = useReducer(choicesReducer, CHOICES_CLOSED);
  // AC-22: Save stays off until the chosen group has a domain.
  const [groupDomain, setGroupDomain] = useState<string | null>(null);
  // Each open gets a new id; the reducer keeps only the latest open's answer.
  const opens = useRef(0);

  const onOpen = () => {
    opens.current += 1;
    const id = opens.current;
    dispatch({ type: "open", id });
    setGroupDomain(null);
    load().then(
      (result) => dispatch({ type: "answer", id, result }),
      () => dispatch({ type: "answer", id, result: null }),
    );
  };

  return (
    <FormDialog
      trigger={trigger}
      title="Add testbed"
      action={action}
      onOpen={onOpen}
      onClosed={() => {
        dispatch({ type: "closed" });
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

const noticeText = (choices: readonly GroupChoice[]): string | undefined => {
  const key = groupNoticeKey(choices);
  return key === undefined ? undefined : TESTBED_MESSAGES[key];
};

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
          groupNotice={noticeText(loaded.choices)}
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
