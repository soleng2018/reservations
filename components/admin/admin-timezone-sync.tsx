"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { setAdminTimezoneAction } from "@/app/admin/users/actions";
import { browserTimeZone } from "@/lib/timezones";

// Spec 0008 AC-3: while the admin's stored zone is still the default UTC,
// send the browser's zone once and refresh, so every console time uses it.
// A failure is silent; the next load tries again. Renders nothing.
export function AdminTimezoneSync({ timezone }: { readonly timezone: string }) {
  const router = useRouter();
  // Once per mount, even when development mode runs effects twice.
  const sent = useRef(false);

  useEffect(() => {
    if (timezone !== "UTC" || sent.current) return;
    const zone = browserTimeZone();
    if (zone === "UTC") return;
    sent.current = true;
    setAdminTimezoneAction(zone).then(
      () => router.refresh(),
      () => undefined,
    );
  }, [timezone, router]);

  return null;
}
