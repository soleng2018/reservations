import type { Metadata } from "next";
import { SetPasswordStart } from "@/components/auth/set-password-start";
import { AlreadySetView, DeadView } from "@/components/auth/set-password-views";
import { LearnerFrame } from "@/components/learner-frame";
import { linkState } from "@/server/auth/set-password-links";
import { db } from "@/server/db";
import { turnstileEnv } from "@/server/env";
import { startSetPassword } from "./actions";

// Spec 0014 AC-9: public, noindex (the root default), and read only: a GET
// changes nothing, so a mail scanner that prefetches the link can't use it.
// No referrer, so the token never leaves in a Referer header.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Set your password",
  referrer: "no-referrer",
};

export default async function SetPasswordPage({
  params,
}: PageProps<"/set-password/[token]">) {
  const { token } = await params;
  const state = await linkState(db(), token);
  const siteKey = turnstileEnv().TURNSTILE_SITE_KEY;

  return (
    <LearnerFrame>
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="flex w-full max-w-sm flex-col gap-8 rounded-lg border bg-card p-8">
          {state.view === "live" ? (
            <SetPasswordStart
              action={startSetPassword.bind(null, token)}
              email={state.link.email}
              siteKey={siteKey}
            />
          ) : state.view === "already_set" ? (
            <AlreadySetView />
          ) : (
            <DeadView siteKey={siteKey} />
          )}
        </div>
      </div>
    </LearnerFrame>
  );
}
