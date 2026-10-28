import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { LearnerFooter } from "@/components/learner-footer";
import { SkipLink } from "@/components/skip-link";
import { UserMenu } from "@/components/user-menu";
import { type CurrentSession, currentSession } from "@/server/auth/require";

// A failed session read (the database is down) counts as signed out for this
// render, so a page that needs no session, like the landing, still loads
// (spec 0009 AC-1). A page that needs the session reads it for itself.
async function sessionOrNone(): Promise<CurrentSession | undefined> {
  try {
    return await currentSession();
  } catch {
    return undefined;
  }
}

// The learner pages' frame (spec 0005 AC-11): the Nile top bar, the page's
// one <main>, and the footer (spec 0009 AC-5). The account menu shows only
// with a session (spec 0005 AC-17). It never links to the admin entry path
// (spec 0003 AC-3).
export async function LearnerFrame({
  children,
}: {
  readonly children: ReactNode;
}) {
  const session = await sessionOrNone();
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
            loading="eager"
          />
          <span className="border-l pl-2.25 text-[0.8125rem] font-semibold">
            Hands-On Labs
          </span>
        </Link>
        {session ? (
          <UserMenu
            name={session.user.name}
            email={session.user.email}
            variant="bar"
          />
        ) : null}
      </header>
      <main id="content" tabIndex={-1} className="flex flex-1 flex-col">
        {children}
      </main>
      <LearnerFooter />
    </>
  );
}
