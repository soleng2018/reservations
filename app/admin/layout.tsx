import type { Metadata } from "next";
import { AdminShell } from "@/components/admin/admin-shell";
import { AdminTimezoneSync } from "@/components/admin/admin-timezone-sync";
import { SkipLink } from "@/components/skip-link";
import { requireAdmin } from "@/server/auth/require";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

// The admin console frame (spec 0005 AC-3). The layout checks the role so
// no chrome renders for anyone else; every page checks again, because a
// layout does not run again on client navigation.
export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const { user } = await requireAdmin();
  return (
    <>
      <SkipLink />
      <AdminTimezoneSync timezone={user.timezone} />
      <AdminShell>{children}</AdminShell>
    </>
  );
}
