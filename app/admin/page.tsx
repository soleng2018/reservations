import type { Metadata } from "next";
import { requireAdmin } from "@/server/auth/require";

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false },
};

// Placeholder console until the admin slices land (tracer for spec 0003).
export default async function AdminHome() {
  const { user, session } = await requireAdmin();
  return (
    <main className="flex flex-1 flex-col gap-2 p-8">
      <h1 className="text-xl font-semibold">Admin console</h1>
      <p>Signed in as {user.name}.</p>
      <p className="text-sm text-zinc-500">
        Session ends {session.expiresAt.toISOString()}.
      </p>
    </main>
  );
}
