import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { CalendarIcon, LayoutGridIcon, RouterIcon } from "lucide-react";
import { LearnerFrame } from "@/components/learner-frame";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { appUrl } from "@/server/env";

// Rendered per request: the metadata needs APP_URL, which `next build` never
// reads. The page reads no session and no database (spec 0009 AC-1, AC-9).
export const dynamic = "force-dynamic";

const TITLE = "Nile Hands-On Labs";
const DESCRIPTION =
  "Reserve a remote Nile testbed with switches, access points, and wireless clients, and start testing in minutes.";
const SOCIAL_IMAGE = {
  url: "/brand/hol-social.jpg",
  width: 1200,
  height: 630,
  alt: TITLE,
};

// The one indexable page; the root layout makes every other page noindex.
// Next writes a URL whose path is only "/" as the bare origin (canonical and
// og:url read APP_URL with no trailing slash); the two are the same URL.
export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL(appUrl()),
    title: { absolute: TITLE },
    description: DESCRIPTION,
    alternates: { canonical: "/" },
    robots: { index: true, follow: true },
    openGraph: {
      type: "website",
      siteName: TITLE,
      title: TITLE,
      description: DESCRIPTION,
      url: "/",
      images: [SOCIAL_IMAGE],
    },
    twitter: {
      card: "summary_large_image",
      title: TITLE,
      description: DESCRIPTION,
      images: [SOCIAL_IMAGE],
    },
  };
}

const STEPS = [
  {
    Icon: LayoutGridIcon,
    title: "Pick a lab type",
    body: "Choose the lab level that matches what you're testing.",
  },
  {
    Icon: CalendarIcon,
    title: "Choose an open time",
    body: "See real-time availability in your own timezone, 24/7.",
  },
  {
    Icon: RouterIcon,
    title: "Get instant access",
    body: "Your lab links and session details arrive as soon as you book.",
  },
] as const;

// The grid goes to two columns at a 736px viewport, and each column reaches
// 520px at 1136px (spec 0009 *Page contract*).
const HERO_SIZES =
  "(min-width: 1136px) 520px, (min-width: 736px) calc((100vw - 96px) / 2), calc(100vw - 56px)";

// The learner home from the mock (spec 0009). Both actions are links, so
// they work without JavaScript; neither names the admin entry.
export default function Home() {
  return (
    <LearnerFrame showSignOut={false}>
      <section className="px-7 pt-16 pb-10">
        <div className="mx-auto grid max-w-[1080px] grid-cols-[repeat(auto-fit,minmax(min(100%,320px),1fr))] items-center gap-10">
          <div>
            <p className="mb-3.5 text-pill font-bold tracking-[0.08em] text-nile-blue uppercase">
              Nile Hands-On Labs
            </p>
            <h1 className="mb-4.5 text-[length:clamp(30px,8vw,42px)] leading-[1.08] font-semibold tracking-[-0.02em] text-fg1">
              Get hands-on with real Nile gear, from anywhere.
            </h1>
            <p className="mb-7 max-w-[480px] text-[1.0625rem] leading-[1.55] text-fg2">
              Reserve a remote testbed with switches, access points, and
              wireless clients, and start testing in minutes. No hardware to
              ship, no VPN to configure.
            </p>
            <div className="flex flex-wrap gap-3.5">
              <Link
                href="/book"
                className={cn(buttonVariants({ variant: "cta", size: "lg" }))}
              >
                Reserve a lab
              </Link>
              <Link
                href="/reservations"
                className={cn(
                  buttonVariants({ variant: "outline", size: "lg" }),
                )}
              >
                Manage an existing reservation
              </Link>
            </div>
          </div>
          <div className="flex justify-center">
            <Image
              src="/brand/hol-hero.jpg"
              alt=""
              width={1920}
              height={1080}
              sizes={HERO_SIZES}
              loading="eager"
              className="h-auto w-full max-w-[520px]"
            />
          </div>
        </div>
      </section>
      <section
        aria-labelledby="how-it-works"
        className="mx-auto w-full max-w-[1080px] px-7 pt-5 pb-20"
      >
        <h2 id="how-it-works" className="sr-only">
          How it works
        </h2>
        <ul className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-5">
          {STEPS.map(({ Icon, title, body }) => (
            <li key={title} className="rounded-xl border bg-card p-6 shadow-xs">
              <div className="mb-4 flex size-10.5 items-center justify-center rounded-lg bg-nile-blue-050 text-nile-blue">
                <Icon aria-hidden="true" className="size-5.25" />
              </div>
              <h3 className="mb-1.5 text-base font-semibold text-fg1">
                {title}
              </h3>
              <p className="text-sub leading-normal text-fg2">{body}</p>
            </li>
          ))}
        </ul>
      </section>
    </LearnerFrame>
  );
}
