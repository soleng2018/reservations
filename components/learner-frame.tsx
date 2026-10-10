import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { LogOutIcon } from "lucide-react";
import { signOut } from "@/app/auth/actions";
import { SkipLink } from "@/components/skip-link";
import { currentSession } from "@/server/auth/require";

// The learner pages' frame (spec 0005 AC-11): the Nile top bar and the
// page's one <main>. Sign out shows only with a session. It never links to
// the admin entry path (spec 0003 AC-3).
export async function LearnerFrame({
  children,
}: {
  readonly children: ReactNode;
}) {
  const session = await currentSession();
  return (
    <>
      <SkipLink />
      <header className="sticky top-0 z-30 flex items-center justify-between gap-4 border-b bg-card px-7 py-4">
        <Link
          href="/"
          className="flex items-center gap-2.25 rounded-sm text-fg2 hover:text-fg1"
        >
          <Image
            src="/brand/nile-logo.png"
            alt="Nile"
            width={44}
            height={22}
            className="h-5.5 w-auto"
            priority
          />
          <span className="border-l pl-2.25 text-[0.8125rem] font-semibold">
            Hands-On Labs
          </span>
        </Link>
        {session ? (
          <form action={signOut}>
            <button
              type="submit"
              className="flex items-center gap-1.5 rounded-sm text-sub font-semibold text-fg2 transition-colors duration-120 hover:text-fg1 [&_svg]:size-4"
            >
              <LogOutIcon aria-hidden="true" />
              Sign out
            </button>
          </form>
        ) : null}
      </header>
      <main id="content" tabIndex={-1} className="flex flex-1 flex-col">
        {children}
      </main>
    </>
  );
}
