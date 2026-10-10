import type { Metadata } from "next";
import { ComingSoon } from "@/components/admin/coming-soon";
import { requireAdmin } from "@/server/auth/require";

export const metadata: Metadata = { title: "API Keys" };

// Built by feature 8.
export default async function ApiKeysPage() {
  await requireAdmin();
  return <ComingSoon section="api-keys" />;
}
