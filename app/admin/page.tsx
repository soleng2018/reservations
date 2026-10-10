import { redirect } from "next/navigation";
import { requireAdmin } from "@/server/auth/require";

// The console opens on Testbed Types (spec 0005 AC-5).
export default async function AdminHome() {
  await requireAdmin();
  redirect("/admin/testbed-types");
}
