"use client";

import { useMemo, useSyncExternalStore } from "react";
import type { FieldControlProps } from "@/components/field";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { zoneLabel } from "@/lib/timezones";

type ZoneOption = { readonly value: string; readonly label: string };

// The options are built in the browser after mount (spec 0010 AC-1): the
// server snapshot is empty, so the first render matches the server HTML, and
// the offsets are the viewer's "now".
const noSubscribe = () => () => {};
const isClient = () => true;
const isServer = () => false;

// AC-1: a case insensitive substring match on the visible label, so "york",
// "gmt-4", and "kolkata" all match.
export const matchesZone = (label: string, query: string): boolean =>
  label.toLowerCase().includes(query.trim().toLowerCase());

// A type to search combobox of IANA zones, each labelled with its current
// offset ("America/New York (GMT-4)"). It submits the zone under `name`, and
// inside a Field the field's id and aria props land on its input.
export function TimezoneCombobox({
  name,
  value,
  onValueChange,
  options,
  ...control
}: FieldControlProps & {
  readonly name: string;
  readonly value: string;
  readonly onValueChange: (zone: string) => void;
  readonly options: readonly string[];
}) {
  const mounted = useSyncExternalStore(noSubscribe, isClient, isServer);
  const items = useMemo<readonly ZoneOption[]>(() => {
    if (!mounted) return [];
    const now = new Date();
    return options.map((zone) => ({
      value: zone,
      label: zoneLabel(zone, now),
    }));
  }, [mounted, options]);
  const selected = items.find((i) => i.value === value) ?? null;

  return (
    <Combobox
      name={name}
      items={items}
      value={selected}
      onValueChange={(item: ZoneOption | null) => {
        if (item) onValueChange(item.value);
      }}
      itemToStringLabel={(item: ZoneOption) => item.label}
      itemToStringValue={(item: ZoneOption) => item.value}
      isItemEqualToValue={(a: ZoneOption, b: ZoneOption) => a.value === b.value}
      filter={(item: ZoneOption, query: string) =>
        matchesZone(item.label, query)
      }
      autoHighlight
    >
      <ComboboxInput
        className="w-full"
        placeholder="Search your timezone"
        triggerLabel="Show timezones"
        autoComplete="off"
        {...control}
      />
      <ComboboxContent>
        <ComboboxEmpty>No timezone matches that.</ComboboxEmpty>
        <ComboboxList>
          {(item: ZoneOption) => (
            <ComboboxItem key={item.value} value={item}>
              {item.label}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
