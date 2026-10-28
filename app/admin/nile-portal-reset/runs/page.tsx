import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeftIcon } from "lucide-react";
import { PageBody } from "@/components/admin/page-body";
import { PageHeader } from "@/components/admin/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime } from "@/lib/format-time";
import {
  countsView,
  reasonText,
  RUNS_LIMIT,
  RUNS_PATH,
  stateTone,
  stateWord,
} from "@/lib/portal-reset/runs-view";
import { requireAdmin } from "@/server/auth/require";
import { db } from "@/server/db";
import { listRuns } from "@/server/portal-reset/runs";

export const metadata: Metadata = { title: "Recent resets" };

// Spec 0023 AC-32: the last 50 resets, read only. Opening it writes nothing.
export default async function RecentResetsPage() {
  const { user } = await requireAdmin();
  const runs = await listRuns(db());

  return (
    <>
      <PageHeader
        title="Recent resets"
        subtitle={`The last ${RUNS_LIMIT} Nile Portal resets and what each one did.`}
        action={
          <Link
            href="/admin/nile-portal-reset"
            className={buttonVariants({ variant: "outline" })}
          >
            <ChevronLeftIcon data-icon="inline-start" aria-hidden="true" />
            Nile Portal Reset
          </Link>
        }
      />
      <PageBody>
        {runs.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>No resets yet</EmptyTitle>
              <EmptyDescription>
                A reset appears here once a lab ends while the mode is dry run
                or live.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table region="Recent resets">
            <TableHeader>
              <TableRow>
                <TableHead>Lab ended</TableHead>
                <TableHead>Testbed</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Deleted</TableHead>
                <TableHead>Changed</TableHead>
                <TableHead>Failed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => {
                const n = countsView(run.counts);
                const why = reasonText(run.abortReason, run.signInReason);
                return (
                  <TableRow key={run.id}>
                    <TableCell className="text-sub whitespace-normal text-fg2">
                      <Link
                        href={`${RUNS_PATH}/${run.id}`}
                        className="font-semibold text-nile-blue underline underline-offset-4"
                      >
                        {formatDateTime(run.labEndedAt, user.timezone)}
                      </Link>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {run.testbedName}
                    </TableCell>
                    <TableCell>
                      {run.mode === "dry_run" ? "Dry run" : "Live"}
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <Badge tone={stateTone(run.state)}>
                        {stateWord(run.state)}
                      </Badge>
                      {why === null ? null : (
                        <p className="mt-1.5 max-w-80 text-sub text-fg3">
                          {why}
                        </p>
                      )}
                    </TableCell>
                    <TableCell>{n.deleted}</TableCell>
                    <TableCell>{n.changed}</TableCell>
                    <TableCell>{n.failed}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </PageBody>
    </>
  );
}
