import { ClockIcon, LockIcon } from "lucide-react";
import {
  LAB_LOGIN_HEADING,
  LAB_LOGIN_TAG,
  LOGINS_TITLE,
  SAME_PASSWORD,
  WINDOW_NOTICE,
  WORK_EMAIL,
  labLoginBody,
} from "@/lib/two-logins-notice";

// The two things a learner must not miss: the links only work during the
// window, and the reservation login and the lab login share one password.
// Shown above the lab access card while the booking's links are live.
export function TwoLoginsNotice({
  nileLogin = null,
}: {
  readonly nileLogin?: string | null;
}) {
  return (
    <div className="mb-3 flex flex-col gap-3">
      <div className="flex items-center gap-3.5 rounded-2xl border-2 border-solar-amber bg-amber-100 px-4 py-3.5">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-solar-amber text-primary-foreground"
        >
          <ClockIcon className="size-5" />
        </span>
        <div>
          <p className="text-[0.9375rem] font-extrabold text-fg1">
            {WINDOW_NOTICE.title}
          </p>
          <p className="text-[0.8125rem] text-fg1">{WINDOW_NOTICE.body}</p>
        </div>
      </div>

      <section
        aria-labelledby="two-logins-title"
        className="overflow-hidden rounded-2xl border-2 border-nile-blue bg-card"
      >
        <h2
          id="two-logins-title"
          className="flex items-center gap-2 bg-nile-blue px-4 py-2.5 text-[0.9375rem] font-extrabold text-primary-foreground"
        >
          <LockIcon aria-hidden="true" className="size-4.5" />
          {LOGINS_TITLE}
        </h2>
        <div className="flex flex-col gap-2.5 px-4 pt-3.5 pb-2">
          <Login
            n="1"
            heading={WORK_EMAIL.heading}
            tag={WORK_EMAIL.tag}
            body={WORK_EMAIL.body}
          />
          <Login
            n="2"
            heading={LAB_LOGIN_HEADING}
            tag={LAB_LOGIN_TAG}
            body={labLoginBody(nileLogin)}
            address={nileLogin}
          />
        </div>
        <p className="mx-4 mt-1 mb-3.5 rounded-lg bg-nile-ink px-3.5 py-2.5 text-center text-sub font-bold text-primary-foreground">
          {SAME_PASSWORD}
        </p>
      </section>
    </div>
  );
}

function Login({
  n,
  heading,
  tag,
  body,
  address = null,
}: {
  readonly n: string;
  readonly heading: string;
  readonly tag: string;
  readonly body: string;
  readonly address?: string | null;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-xl bg-nile-blue-050 px-3.5 py-3">
      <p className="flex items-center gap-2 text-sub font-bold text-fg1">
        <span
          aria-hidden="true"
          className="flex size-6 items-center justify-center rounded-full bg-nile-blue text-[0.8125rem] font-bold text-primary-foreground"
        >
          {n}
        </span>
        {heading}
      </p>
      <p className="text-xs font-bold tracking-[0.04em] text-nile-blue-700 uppercase">
        {tag}
      </p>
      <p className="text-[0.8125rem] leading-snug text-fg1">{body}</p>
      {address === null ? null : (
        <p className="font-mono text-[0.8125rem] font-semibold wrap-anywhere text-nile-blue-700">
          {address}
        </p>
      )}
    </div>
  );
}
