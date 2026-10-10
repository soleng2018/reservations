"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { LogOutIcon } from "lucide-react";
import { signOut } from "@/app/auth/actions";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { ADMIN_NAV, activeSection } from "@/lib/admin-nav";
import { cn } from "@/lib/utils";

type AdminNav = {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly menuButton: RefObject<HTMLButtonElement | null>;
};

const AdminNavContext = createContext<AdminNav | null>(null);

// For PageHeader's menu button, which opens the mobile drawer.
export function useAdminNav(): AdminNav {
  const nav = useContext(AdminNavContext);
  if (!nav) throw new Error("useAdminNav outside AdminShell");
  return nav;
}

// The same media query as the `nav:` variant (--breakpoint-nav).
const DESKTOP = "(min-width: 55rem)";

// The admin console frame (spec 0005 AC-3, AC-4). From the nav breakpoint
// up, a fixed Ink sidebar; below it, the same nav in a left drawer opened
// from PageHeader. No padding around the page.
export function AdminShell({ children }: { readonly children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);

  // A drawer left open while the window grows past the breakpoint closes.
  useEffect(() => {
    const query = window.matchMedia(DESKTOP);
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setOpen(false);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return (
    <AdminNavContext value={{ open, setOpen, menuButton }}>
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-62 flex-col bg-sidebar px-4 py-5.5 [--focus-ring:var(--sidebar-ring)] nav:flex">
        <NavPanel />
      </aside>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="left"
          showCloseButton={false}
          finalFocus={menuButton}
          className="gap-0 bg-sidebar px-4 py-5.5 text-sidebar-foreground [--focus-ring:var(--sidebar-ring)] data-[side=left]:w-62 data-[side=left]:border-sidebar-border data-[side=left]:sm:max-w-62"
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <NavPanel onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
      <div className="flex min-h-screen min-w-0 flex-1 flex-col nav:ml-62">
        {children}
      </div>
    </AdminNavContext>
  );
}

const itemClass =
  "flex w-full items-center gap-3 rounded-sm px-3 py-2.75 text-left text-cell font-medium transition-colors duration-120 [&_svg]:size-4.75 [&_svg]:shrink-0";

function NavPanel({ onNavigate }: { readonly onNavigate?: () => void }) {
  const active = activeSection(usePathname());
  return (
    <>
      <div className="flex items-center gap-2.25 px-2 pt-1.5 pb-6.5">
        <Image
          src="/brand/nile-logo-white.png"
          alt="Nile"
          width={48}
          height={24}
          className="h-6 w-auto"
          priority
        />
        <span className="border-l border-sidebar-foreground/30 pl-2.25 text-pill font-semibold text-nile-sky">
          Hands-On Labs
        </span>
      </div>
      <nav aria-label="Admin" className="flex-1">
        <ul className="flex flex-col gap-1">
          {ADMIN_NAV.map((item) => {
            const current = item.section === active;
            return (
              <li key={item.section}>
                <Link
                  href={item.href}
                  aria-current={current ? "page" : undefined}
                  onClick={onNavigate}
                  className={cn(
                    itemClass,
                    current
                      ? "bg-sidebar-primary text-sidebar-primary-foreground"
                      : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  )}
                >
                  <item.icon aria-hidden="true" />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="border-t border-sidebar-border pt-3">
        <form action={signOut}>
          <button
            type="submit"
            className={cn(
              itemClass,
              "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            )}
          >
            <LogOutIcon aria-hidden="true" />
            Sign out
          </button>
        </form>
      </div>
    </>
  );
}
