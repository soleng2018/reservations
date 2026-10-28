import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { z } from "zod";
import { PageBody } from "@/components/admin/page-body";
import { PageHeader } from "@/components/admin/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
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
  kindTone,
  kindWord,
  pageNumber,
  reasonText,
  RUNS_PATH,
  stateTone,
  stateWord,
} from "@/lib/portal-reset/runs-view";
import { requireAdmin } from "@/server/auth/require";
import { db } from "@/server/db";
import { readRun } from "@/server/portal-reset/runs";

export const metadata: Metadata = { title: "Reset details" };

// Spec 0023 AC-32: one run and its records, 200 a page, read only.
export default async function ResetDetailPage({
  params,
  searchParams,
}: PageProps<"/admin/nile-portal-reset/runs/[id]">) {
  const { user } = await requireAdmin();
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const detail = await readRun(
    db(),
    id.data,
    pageNumber((await searchParams).page),
  );
  if (detail === undefined) notFound();
  const { run, items, page, pages, total } = detail;
  const why = reasonText(run.abortReason, run.signInReason);
  const at = (d: Date | null) =>
    d === null ? "Not yet" : formatDateTime(d, user.timezone);
  const pageHref = (n: number) => `${RUNS_PATH}/${run.id}?page=${n}`;

  return (
    <>
      <PageHeader
        title={`Reset of ${run.testbedName}`}
        subtitle={`Lab ended ${at(run.labEndedAt)}.`}
        action={
          <Link
            href={RUNS_PATH}
            className={buttonVariants({ variant: "outline" })}
          >
            <ChevronLeftIcon data-icon="inline-start" aria-hidden="true" />
            Recent resets
          </Link>
        }
      />
      <PageBody>
        <dl className="grid gap-x-8 gap-y-3 rounded-xl border bg-card p-5 text-sub sm:grid-cols-2">
          <Fact term="Outcome">
            <Badge tone={stateTone(run.state)}>{stateWord(run.state)}</Badge>
          </Fact>
          <Fact term="Mode">{run.mode === "dry_run" ? "Dry run" : "Live"}</Fact>
          <Fact term="Started">{at(run.startedAt)}</Fact>
          <Fact term="Finished">{at(run.finishedAt)}</Fact>
          {why === null ? null : <Fact term="Why">{why}</Fact>}
        </dl>
        {items.length === 0 ? (
          <p className="text-sub text-fg3">
            This reset recorded no items. Empty lists, system items, and items
            already gone are not recorded.
          </p>
        ) : (
          <>
            <Table region="Items of this reset">
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>What</TableHead>
                  <TableHead>Step</TableHead>
                  <TableHead>Item</TableHead>
                  <TableHead>Call</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Message</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.seq}>
                    <TableCell>{item.seq}</TableCell>
                    <TableCell>
                      <Badge tone={kindTone(item.kind)}>
                        {kindWord(item.kind)}
                      </Badge>
                      {item.kind === "failed" && item.resolved ? (
                        <p className="mt-1 text-sub text-fg3">Fixed on retry</p>
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {item.stepKey}
                    </TableCell>
                    <TableCell className="max-w-60 whitespace-normal">
                      {item.label ?? item.itemId ?? ""}
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {[item.method, item.route]
                        .filter((p) => p !== null)
                        .join(" ")}
                    </TableCell>
                    <TableCell>{item.status ?? ""}</TableCell>
                    <TableCell className="max-w-80 whitespace-normal text-fg2">
                      {item.message ?? ""}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {pages > 1 ? (
              <nav
                aria-label="Pages of items"
                className="flex items-center justify-between gap-3"
              >
                <p className="text-sub text-fg3">
                  Page {page} of {pages}, {total} items.
                </p>
                <div className="flex gap-2">
                  {page > 1 ? (
                    <Link
                      href={pageHref(page - 1)}
                      className={buttonVariants({ variant: "outline" })}
                    >
                      <ChevronLeftIcon
                        data-icon="inline-start"
                        aria-hidden="true"
                      />
                      Previous
                    </Link>
                  ) : null}
                  {page < pages ? (
                    <Link
                      href={pageHref(page + 1)}
                      className={buttonVariants({ variant: "outline" })}
                    >
                      Next
                      <ChevronRightIcon
                        data-icon="inline-end"
                        aria-hidden="true"
                      />
                    </Link>
                  ) : null}
                </div>
              </nav>
            ) : null}
          </>
        )}
      </PageBody>
    </>
  );
}

function Fact({
  term,
  children,
}: {
  readonly term: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="font-semibold text-fg3">{term}</dt>
      <dd className="text-fg1">{children}</dd>
    </div>
  );
}
