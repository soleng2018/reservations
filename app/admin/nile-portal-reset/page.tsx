import type { Metadata } from "next";
import { savePortalResetAction } from "@/app/admin/actions";
import { PortalResetEditor } from "@/components/admin/portal-reset-editor";
import { AUDIT_LOG_PATH } from "@/lib/audit-log";
import { formatDateTime } from "@/lib/format-time";
import type { EditorStep } from "@/lib/portal-reset/draft";
import { rowView } from "@/lib/portal-reset/view";
import { requireAdmin } from "@/server/auth/require";
import { db } from "@/server/db";
import { readResetPage } from "@/server/portal-reset/steps";

export const metadata: Metadata = { title: "Nile Portal Reset" };

// Spec 0022: the reset list, read only until the admin clicks Edit. The page
// never contacts a Nile Portal (AC-14).
export default async function NilePortalResetPage() {
  const { user } = await requireAdmin();
  const list = await readResetPage(db());

  const steps: EditorStep[] = list.steps.map((read) =>
    read.ok
      ? { ...read.step }
      : {
          id: read.id,
          featureName: read.featureName,
          enabled: read.enabled,
          note: read.note,
          definition: read.definition,
        },
  );
  const rows = list.steps.map((read) =>
    read.ok ? rowView(read.step, read.step.definition) : rowView(read, null),
  );
  const lastSaved =
    list.updatedByName === null
      ? null
      : `${list.updatedByName} on ${formatDateTime(list.updatedAt, user.timezone)}`;

  return (
    <PortalResetEditor
      version={list.version}
      abortEmail={list.abortEmail}
      mode={list.mode}
      lastSaved={lastSaved}
      steps={steps}
      rows={rows}
      historyHref={`${AUDIT_LOG_PATH}?area=portal_reset`}
      save={savePortalResetAction}
    />
  );
}
