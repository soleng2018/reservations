// Reordering the draft by drag (spec 0022 AC-6, AC-8): the pure parts, so
// nothing here needs a browser. Safe on both sides.

// A copy of `items` with the one at `from` moved to `to`. An index outside the
// list changes nothing.
export function moveItem<T>(
  items: readonly T[],
  from: number,
  to: number,
): readonly T[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= items.length ||
    to >= items.length
  ) {
    return items;
  }
  const rest = items.filter((_, i) => i !== from);
  return [...rest.slice(0, to), items[from], ...rest.slice(to)];
}

type Id = string | number;
type Event = {
  readonly active: { readonly id: Id };
  readonly over?: { readonly id: Id } | null;
};

export const REORDER_INSTRUCTIONS =
  "To move a step, press Space or Enter on its handle, use the arrow keys to move it, then press Space to drop it. Press Escape to cancel.";

// What a screen reader hears while a row is lifted, moved, and dropped: the
// row's name and its place ("SSIDs, position 3 of 12"). `rows` is the order on
// screen when the drag started.
export function reorderAnnouncements(
  rows: readonly { readonly id: string; readonly name: string }[],
) {
  const place = (id: Id): string => {
    const index = rows.findIndex((r) => r.id === String(id));
    return index < 0 ? "" : `position ${index + 1} of ${rows.length}`;
  };
  const name = (id: Id): string =>
    rows.find((r) => r.id === String(id))?.name ?? "Step";
  return {
    onDragStart: ({ active }: Event) =>
      `Picked up ${name(active.id)}, ${place(active.id)}.`,
    onDragOver: ({ active, over }: Event) =>
      over
        ? `${name(active.id)} moved to ${place(over.id)}.`
        : `${name(active.id)} is not over a place.`,
    onDragEnd: ({ active, over }: Event) =>
      over
        ? `${name(active.id)} dropped at ${place(over.id)}.`
        : `${name(active.id)} dropped where it was.`,
    onDragCancel: ({ active }: Event) =>
      `Move cancelled. ${name(active.id)} is back at ${place(active.id)}.`,
  };
}
