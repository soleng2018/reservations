import type { Metadata } from "next";
import { AdminShell } from "@/components/admin/admin-shell";
import { SkipLink } from "@/components/skip-link";
import { requireAdmin } from "@/server/auth/require";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

// The admin console frame (spec 0005 AC-3). The layout checks the role so
// no chrome renders for anyone else; every page checks again, because a
// layout does not run again on client navigation.
export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  await requireAdmin();
  return (
    <>
      <SkipLink />
      <AdminShell>{children}</AdminShell>
    </>
  );
}
