"use client";

import { ChevronsUpDownIcon, LogOutIcon } from "lucide-react";
import { signOut } from "@/app/auth/actions";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { initialsOf } from "@/lib/initials";
import { cn } from "@/lib/utils";

// The signed in user's account menu (spec 0005 AC-17): an avatar with their
// initials that opens their name, email and Sign out. "sidebar" is the full
// width row at the bottom of the admin nav; "bar" is the avatar alone in the
// learner top bar. It holds no session logic: the caller passes what the
// session's users row says.
export function UserMenu({
  name,
  email,
  variant,
}: {
  readonly name: string;
  readonly email: string;
  readonly variant: "sidebar" | "bar";
}) {
  const sidebar = variant === "sidebar";
  const avatar = (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-nile-cta text-pill font-bold text-primary-foreground"
    >
      {initialsOf(name)}
    </span>
  );
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`Account menu for ${name}`}
        className={cn(
          "flex items-center gap-2.5 rounded-full",
          sidebar &&
            "w-full rounded-sm px-3 py-2 text-left text-cell font-medium text-sidebar-foreground transition-colors duration-120 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        )}
      >
        {avatar}
        {sidebar ? (
          <>
            <span className="min-w-0 flex-1 truncate">{name}</span>
            <ChevronsUpDownIcon
              aria-hidden="true"
              className="size-4 shrink-0 opacity-70"
            />
          </>
        ) : null}
      </PopoverTrigger>
      <PopoverContent
        side={sidebar ? "top" : "bottom"}
        align={sidebar ? "start" : "end"}
        className="w-64 gap-0 p-0"
      >
        <div className="flex flex-col gap-0.5 px-3.5 py-3">
          <p className="truncate font-semibold text-fg1" title={name}>
            {name}
          </p>
          <p className="truncate text-sub text-fg3" title={email}>
            {email}
          </p>
        </div>
        <div className="border-t p-1.5">
          <form action={signOut}>
            <button
              type="submit"
              className="flex w-full items-center gap-2.5 rounded-sm px-2 py-2 text-left text-cell font-medium text-fg1 transition-colors duration-120 hover:bg-bg-inset [&_svg]:size-4"
            >
              <LogOutIcon aria-hidden="true" />
              Sign out
            </button>
          </form>
        </div>
      </PopoverContent>
    </Popover>
  );
}
