import Link from "next/link";
import { ChevronDownIcon, SearchIcon } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ACTOR_KIND_LABEL,
  AUDIT_AREA_LABEL,
  AUDIT_LOG_PATH,
  ActorKind,
  AuditArea,
  type AuditQuery,
} from "@/lib/audit-log";
import { cn } from "@/lib/utils";

type Option = { readonly value: string; readonly label: string };

// A native select in the Input look, so the GET form submits before
// hydration (spec 0016 AC-4).
function NativeSelect({
  id,
  name,
  label,
  placeholder,
  options,
  value,
}: {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly placeholder: string;
  readonly options: readonly Option[];
  readonly value?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <select
          id={id}
          name={name}
          defaultValue={value ?? ""}
          className="w-full min-w-0 appearance-none rounded-md border-[1.5px] border-input bg-card py-2.75 pr-10 pl-3.25 text-cell text-fg1 transition-colors duration-120 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/35"
        >
          <option value="">{placeholder}</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDownIcon
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 right-3 size-5 -translate-y-1/2 text-fg2"
        />
      </div>
    </div>
  );
}

const ACTOR_OPTIONS = ActorKind.options.map((k) => ({
  value: k,
  label: ACTOR_KIND_LABEL[k],
}));
const AREA_OPTIONS = AuditArea.options.map((a) => ({
  value: a,
  label: AUDIT_AREA_LABEL[a],
}));

// The Audit Log filters (AC-4): a plain GET form, so every filter lives in
// the URL. It carries the history filters (AC-5) as hidden fields, and
// sends no cursor, so applying a filter starts from the newest page.
export function AuditFilters({
  query,
  admins,
}: {
  readonly query: AuditQuery;
  readonly admins: readonly { readonly id: string; readonly name: string }[];
}) {
  return (
    <form
      method="get"
      action={AUDIT_LOG_PATH}
      role="search"
      aria-label="Filter audit entries"
      className="grid gap-4 rounded-xl border bg-card px-5 py-4.5 shadow-xs sm:grid-cols-2 lg:grid-cols-[repeat(5,minmax(0,1fr))_auto]"
    >
      {query.target ? (
        <input
          type="hidden"
          name="target"
          value={`${query.target.type}:${query.target.id}`}
        />
      ) : null}
      {query.learner ? (
        <input type="hidden" name="learner" value={query.learner} />
      ) : null}
      <div className="flex min-w-0 flex-col gap-1.5 sm:col-span-2 lg:col-span-6">
        <Label htmlFor="audit-q">Search</Label>
        <div className="relative">
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-fg3"
          />
          <Input
            id="audit-q"
            type="search"
            name="q"
            defaultValue={query.q ?? ""}
            maxLength={100}
            autoComplete="off"
            placeholder="Summary, action, person, or target…"
            className="pl-10"
          />
        </div>
      </div>
      <NativeSelect
        id="audit-actor"
        name="actor"
        label="Who"
        placeholder="Anyone"
        options={ACTOR_OPTIONS}
        value={query.actor}
      />
      <NativeSelect
        id="audit-area"
        name="area"
        label="Area"
        placeholder="All areas"
        options={AREA_OPTIONS}
        value={query.area}
      />
      <NativeSelect
        id="audit-admin"
        name="admin"
        label="Admin"
        placeholder="Any admin"
        options={admins.map((a) => ({ value: a.id, label: a.name }))}
        value={query.admin}
      />
      <div className="flex min-w-0 flex-col gap-1.5">
        <Label htmlFor="audit-from">From</Label>
        <Input
          id="audit-from"
          type="date"
          name="from"
          defaultValue={query.from ?? ""}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <Label htmlFor="audit-to">To</Label>
        <Input
          id="audit-to"
          type="date"
          name="to"
          defaultValue={query.to ?? ""}
        />
      </div>
      <div className="flex items-end gap-2.5 sm:col-span-2 lg:col-span-1">
        <Button type="submit">Apply</Button>
        <Link
          href={AUDIT_LOG_PATH}
          className={cn(buttonVariants({ variant: "outline" }))}
        >
          Clear
        </Link>
      </div>
    </form>
  );
}
