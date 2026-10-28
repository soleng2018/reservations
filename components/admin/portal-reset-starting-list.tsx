"use client";

import { ListPlusIcon, PlusIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { StartingChoice } from "@/lib/portal-reset/draft";

type Open = {
  readonly choice: StartingChoice;
  readonly nameTaken: boolean;
};

// "Add from starting list (N)" (spec 0022 AC-13, AC-26): the tested steps from
// the repo file that are not in the table and not already in the draft. Adding
// puts the row at the end of the draft; it is stored only on Save. A step that
// was removed and saved is offered here again, so a tested step is never lost.
export function PortalResetStartingList({
  open,
  disabled,
  onAdd,
}: {
  readonly open: readonly Open[];
  readonly disabled: boolean;
  readonly onAdd: (choice: StartingChoice) => void;
}) {
  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button variant="outline" disabled={disabled || open.length === 0} />
        }
      >
        <ListPlusIcon data-icon="inline-start" aria-hidden="true" />
        Add from starting list ({open.length})
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add from starting list</DialogTitle>
          <DialogDescription>
            The tested steps that ship with the app. A step you removed and
            saved shows here again, so you can add it back. Nothing is stored
            until you save the page.
          </DialogDescription>
        </DialogHeader>
        {open.length === 0 ? (
          <p className="text-sub text-fg3">
            Every starting step is in your list.
          </p>
        ) : (
          <ul className="flex flex-col divide-y">
            {open.map(({ choice, nameTaken }) => (
              <li
                key={choice.key}
                className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-cell font-semibold text-fg1">
                      {choice.featureName}
                    </span>
                    {choice.enabled ? null : (
                      <Badge tone="neutral">Disabled</Badge>
                    )}
                  </div>
                  {choice.note === null ? null : (
                    <p className="text-xs break-words text-fg3">
                      {choice.note}
                    </p>
                  )}
                  {choice.description.map((line, i) => (
                    <p key={i} className="text-sub break-words text-fg2">
                      {line}
                    </p>
                  ))}
                  {nameTaken ? (
                    <p className="text-xs text-danger-strong">
                      A step named {choice.featureName} is already in the list.
                      Rename or remove it first.
                    </p>
                  ) : null}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={nameTaken}
                  aria-label={`Add ${choice.featureName} to the draft`}
                  onClick={() => onAdd(choice)}
                >
                  <PlusIcon data-icon="inline-start" aria-hidden="true" />
                  Add
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
