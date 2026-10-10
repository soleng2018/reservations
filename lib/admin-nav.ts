import {
  LayoutGridIcon,
  LockIcon,
  RouterIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";

// The admin console's sections, in nav order, with the mock's titles and
// subtitles (spec 0005 *Value sourcing*).
export const ADMIN_SECTIONS = [
  "api-keys",
  "testbed-types",
  "testbeds",
  "users",
] as const;

export type AdminSection = (typeof ADMIN_SECTIONS)[number];

export type AdminNavItem = {
  readonly section: AdminSection;
  readonly href: `/admin/${AdminSection}`;
  readonly label: string;
  readonly subtitle: string;
  readonly icon: LucideIcon;
};

export const ADMIN_NAV: readonly AdminNavItem[] = [
  {
    section: "api-keys",
    href: "/admin/api-keys",
    label: "API Keys",
    subtitle:
      "Credentials used to connect testbeds to identity providers and AI services.",
    icon: LockIcon,
  },
  {
    section: "testbed-types",
    href: "/admin/testbed-types",
    label: "Testbed Types",
    subtitle: "Lab difficulty levels and how long each reservation lasts.",
    icon: LayoutGridIcon,
  },
  {
    section: "testbeds",
    href: "/admin/testbeds",
    label: "Testbeds",
    subtitle: "The remote labs customers can reserve.",
    icon: RouterIcon,
  },
  {
    section: "users",
    href: "/admin/users",
    label: "Users",
    subtitle: "Everyone with hands-on lab access.",
    icon: UsersIcon,
  },
];

export function navItem(section: AdminSection): AdminNavItem {
  const item = ADMIN_NAV.find((i) => i.section === section);
  if (!item) throw new Error(`ADMIN_NAV has no ${section}`);
  return item;
}

// The section a path belongs to, matched by prefix, so /admin/users/123
// keeps Users active.
export const activeSection = (pathname: string): AdminSection | undefined =>
  ADMIN_NAV.find(
    (i) => pathname === i.href || pathname.startsWith(`${i.href}/`),
  )?.section;
