"use client";

import type { ReactNode } from "react";
import { MenuIcon } from "lucide-react";
import { useAdminNav } from "@/components/admin/admin-shell";
import { Button } from "@/components/ui/button";
import { navItem, type AdminSection } from "@/lib/admin-nav";

type Heading =
  | { readonly section: AdminSection }
  | { readonly title: string; readonly subtitle: string };

// The white bar at the top of every admin page (AC-3): the section title and
// subtitle from ADMIN_NAV (or explicit ones, for pages outside the nav), an
// optional primary action, and below the nav breakpoint the menu button.
export function PageHeader(props: Heading & { readonly action?: ReactNode }) {
  const { open, setOpen, menuButton } = useAdminNav();
  const { title, subtitle } =
    "section" in props
      ? {
          title: navItem(props.section).label,
          subtitle: navItem(props.section).subtitle,
        }
      : props;

  return (
    <header className="flex items-center justify-between gap-4 border-b bg-card px-7 py-5">
      <div className="flex min-w-0 items-center gap-3.5">
        <Button
          ref={menuButton}
          variant="outline"
          size="icon-lg"
          className="nav:hidden"
          aria-label="Open navigation"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          <MenuIcon aria-hidden="true" />
        </Button>
        <div className="min-w-0">
          <h1 className="truncate text-title font-semibold tracking-[-0.02em] text-fg1">
            {title}
          </h1>
          <p className="mt-0.75 truncate text-sub text-fg3">{subtitle}</p>
        </div>
      </div>
      {props.action ? (
        <div className="flex shrink-0 items-center gap-2.5">{props.action}</div>
      ) : null}
    </header>
  );
}
