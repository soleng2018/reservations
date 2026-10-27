"use client";

import { type CSSProperties, type ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  GripVerticalIcon,
  ListChecksIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  REORDER_INSTRUCTIONS,
  reorderAnnouncements,
} from "@/lib/portal-reset/reorder";
import type { ResetRowView } from "@/lib/portal-reset/view";
import { cn } from "@/lib/utils";

// Edit mode: rows can be dragged by their handle (spec 0022 AC-6, AC-8).
// `onMove` gets the old and the new place; the caller reorders its draft.
export type Reorder = {
  readonly onMove: (from: number, to: number) => void;
  readonly disabled: boolean;
};

// The reset list as text (spec 0022 AC-4): order number, feature name, a
// Disabled badge, what the step does in plain words, the guards that apply,
// and the note. Below the nav breakpoint each row is a stacked card
// (AC-15); from it, one ruled list in a single card. Edit mode adds a button
// column (`actions`), the problems a Save found in a row (`problems`), and
// drag handles (`reorder`).
export function PortalResetSteps({
  rows,
  actions,
  problems,
  reorder,
  emptyDescription = "The starting list is loaded the first time the app is deployed.",
}: {
  readonly rows: readonly ResetRowView[];
  readonly actions?: (row: ResetRowView) => ReactNode;
  readonly problems?: (row: ResetRowView) => readonly string[];
  readonly reorder?: Reorder;
  readonly emptyDescription?: string;
}) {
  if (rows.length === 0) {
    return (
      <Empty className="rounded-xl border border-solid bg-card shadow-xs">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ListChecksIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>No reset steps yet</EmptyTitle>
          <EmptyDescription>{emptyDescription}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const list = (
    <ol
      aria-label="Reset steps, in the order a reset runs them"
      className="flex flex-col gap-3 nav:gap-0 nav:divide-y nav:overflow-hidden nav:rounded-xl nav:border nav:bg-card nav:shadow-xs"
    >
      {rows.map((row, index) =>
        reorder ? (
          <SortableRow
            key={row.id}
            row={row}
            index={index}
            total={rows.length}
            disabled={reorder.disabled}
            actions={actions}
            problems={problems}
          />
        ) : (
          <li key={row.id} className={rowClass(actions !== undefined, false)}>
            <RowBody row={row} actions={actions} problems={problems} />
          </li>
        ),
      )}
    </ol>
  );
  return reorder ? (
    <Sortable rows={rows} reorder={reorder}>
      {list}
    </Sortable>
  ) : (
    list
  );
}

const rowClass = (withActions: boolean, withHandle: boolean) =>
  cn(
    "grid gap-x-5 gap-y-3 rounded-xl border bg-card px-5 py-4 shadow-xs nav:rounded-none nav:border-0 nav:shadow-none",
    withHandle
      ? withActions
        ? "nav:grid-cols-[2rem_2rem_15rem_minmax(0,1fr)_auto]"
        : "nav:grid-cols-[2rem_2rem_15rem_minmax(0,1fr)]"
      : withActions
        ? "nav:grid-cols-[2rem_15rem_minmax(0,1fr)_auto]"
        : "nav:grid-cols-[2rem_15rem_minmax(0,1fr)]",
  );

// The drag layer, mounted only in edit mode (so it never renders on the
// server). Mouse and touch start a drag from the handle only; touch waits a
// short press so a scroll is not a drag; the keyboard lifts with Space or
// Enter and moves with the arrows (AC-8).
function Sortable({
  rows,
  reorder,
  children,
}: {
  readonly rows: readonly ResetRowView[];
  readonly reorder: Reorder;
  readonly children: ReactNode;
}) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over === null || active.id === over.id) return;
    const from = rows.findIndex((r) => r.id === active.id);
    const to = rows.findIndex((r) => r.id === over.id);
    if (from >= 0 && to >= 0) reorder.onMove(from, to);
  };
  return (
    <DndContext
      id="portal-reset-steps"
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
      accessibility={{
        announcements: reorderAnnouncements(
          rows.map((r) => ({ id: r.id, name: r.featureName })),
        ),
        screenReaderInstructions: { draggable: REORDER_INSTRUCTIONS },
      }}
    >
      <SortableContext
        items={rows.map((r) => r.id)}
        strategy={verticalListSortingStrategy}
      >
        {children}
      </SortableContext>
    </DndContext>
  );
}

function SortableRow({
  row,
  index,
  total,
  disabled,
  actions,
  problems,
}: {
  readonly row: ResetRowView;
  readonly index: number;
  readonly total: number;
  readonly disabled: boolean;
  readonly actions: ((row: ResetRowView) => ReactNode) | undefined;
  readonly problems: ((row: ResetRowView) => readonly string[]) | undefined;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: row.id, disabled });
  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
  };
  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        rowClass(actions !== undefined, true),
        "motion-reduce:transition-none",
        isDragging && "relative z-10 shadow-lg ring-2 ring-ring",
      )}
    >
      <RowBody
        row={row}
        actions={actions}
        problems={problems}
        handle={
          <button
            type="button"
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            disabled={disabled}
            aria-label={`Reorder ${row.featureName}, position ${index + 1} of ${total}`}
            className="flex size-8 shrink-0 touch-none items-center justify-center rounded-md text-fg3 hover:bg-bg-inset hover:text-fg1 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50"
          >
            <GripVerticalIcon className="size-4" aria-hidden="true" />
          </button>
        }
      />
    </li>
  );
}

function RowBody({
  row,
  actions,
  problems,
  handle,
}: {
  readonly row: ResetRowView;
  readonly actions: ((row: ResetRowView) => ReactNode) | undefined;
  readonly problems: ((row: ResetRowView) => readonly string[]) | undefined;
  readonly handle?: ReactNode;
}) {
  return (
    <>
      <div className="flex min-w-0 items-start gap-3 nav:contents">
        {handle}
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-bg-inset text-sub font-semibold text-fg2"
          data-testid="step-number"
        >
          <span className="sr-only">Step </span>
          {row.position}
        </span>
        <div className="flex min-w-0 flex-col items-start gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-cell font-semibold text-fg1">
              {row.featureName}
            </span>
            {row.enabled ? null : <Badge tone="neutral">Disabled</Badge>}
          </div>
          {row.note === null ? null : (
            <p className="text-xs break-words text-fg3">{row.note}</p>
          )}
        </div>
      </div>
      <div
        className={cn(
          "flex min-w-0 flex-col gap-2",
          handle ? "nav:col-start-4" : "nav:col-start-3",
        )}
      >
        {row.invalid ? (
          <p role="alert" className="text-sub text-danger-strong">
            This step no longer reads as a valid step. A reset stops at it until
            it is fixed.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {row.description.map((line, i) => (
              <li key={i} className="text-sub break-words text-fg2">
                {line}
              </li>
            ))}
          </ul>
        )}
        {row.guardLines.map((line) => (
          <p key={line} className="flex items-start gap-1.5 text-xs text-fg3">
            <ShieldCheckIcon
              className="mt-0.5 size-3.5 shrink-0"
              aria-hidden="true"
            />
            <span>{line}</span>
          </p>
        ))}
        {(problems?.(row) ?? []).length > 0 ? (
          <ul
            aria-label={`Problems in ${row.featureName}`}
            className="flex flex-col gap-1 text-xs text-danger-strong"
          >
            {(problems?.(row) ?? []).map((line) => (
              <li key={line} className="break-words">
                {line}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {actions ? (
        <div
          className={cn(
            "flex items-start gap-2 nav:row-start-1",
            handle ? "nav:col-start-5" : "nav:col-start-4",
          )}
        >
          {actions(row)}
        </div>
      ) : null}
    </>
  );
}
