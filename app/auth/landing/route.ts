import { redirect } from "next/navigation";
import { currentSession } from "@/server/auth/require";

// After Authentik: the role, not the entry point, decides the landing (AC-2).
export async function GET() {
  const current = await currentSession();
  if (!current) redirect("/auth/error?reason=unknown");
  redirect(current.user.role === "admin" ? "/admin" : "/reservations");
}
