import type { Metadata } from "next";
import { ComingSoon } from "@/components/admin/coming-soon";
import { requireAdmin } from "@/server/auth/require";

export const metadata: Metadata = { title: "Users" };

// Built by feature 10.
export default async function UsersPage() {
  await requireAdmin();
  return <ComingSoon section="users" />;
}
