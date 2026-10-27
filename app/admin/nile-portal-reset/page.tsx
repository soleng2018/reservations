import type { Metadata } from "next";
import Link from "next/link";
import { HistoryIcon } from "lucide-react";
import { PageBody } from "@/components/admin/page-body";
import { PageHeader } from "@/components/admin/page-header";
import { PortalResetSettings } from "@/components/admin/portal-reset-settings";
import { PortalResetSteps } from "@/components/admin/portal-reset-steps";
import { buttonVariants } from "@/components/ui/button";
import { AUDIT_LOG_PATH } from "@/lib/audit-log";
import { formatDateTime } from "@/lib/format-time";
import { rowView } from "@/lib/portal-reset/view";
import { requireAdmin } from "@/server/auth/require";
import { db } from "@/server/db";
import { readResetPage } from "@/server/portal-reset/steps";

export const metadata: Metadata = { title: "Nile Portal Reset" };

// Spec 0022: the reset list as text. Reads only; the page never contacts a
// Nile Portal (AC-14). Edit mode and Save follow on this same page.
export default async function NilePortalResetPage() {
  const { user } = await requireAdmin();
  const list = await readResetPage(db());

  const rows = list.steps.map((read) =>
    read.ok
      ? rowView(read.step, read.step.definition)
      : rowView({ ...read, enabled: true, note: null }, null),
  );
  const lastSaved =
    list.updatedByName === null
      ? null
      : `${list.updatedByName} on ${formatDateTime(list.updatedAt, user.timezone)}`;

  return (
    <>
      <PageHeader
        section="nile-portal-reset"
        action={
          <Link
            href={`${AUDIT_LOG_PATH}?area=portal_reset`}
            className={buttonVariants({ variant: "outline" })}
          >
            <HistoryIcon data-icon="inline-start" aria-hidden="true" />
            History
          </Link>
        }
      />
      <PageBody>
        <PortalResetSettings
          abortEmail={list.abortEmail}
          mode={list.mode}
          lastSaved={lastSaved}
        />
        <PortalResetSteps rows={rows} />
      </PageBody>
    </>
  );
}
