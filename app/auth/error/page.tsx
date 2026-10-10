import type { Metadata } from "next";
import Link from "next/link";
import { authErrorView } from "@/lib/auth-errors";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false },
};

const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

export default async function AuthErrorPage({
  searchParams,
}: PageProps<"/auth/error">) {
  const params = await searchParams;
  const view = authErrorView({
    reason: first(params.reason),
    error: first(params.error),
  });
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-lg border p-8">
        <h1 className="text-xl font-semibold">{view.title}</h1>
        <p>{view.message}</p>
        {view.reserveLink ? (
          <Link href="/" className="font-medium underline">
            Reserve a lab
          </Link>
        ) : (
          <Link href="/" className="text-sm text-muted-foreground underline">
            Back to the home page
          </Link>
        )}
      </div>
    </main>
  );
}
