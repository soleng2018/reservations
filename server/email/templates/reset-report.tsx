import "server-only";
import { Section, Text } from "react-email";
import { formatEmailDateTime } from "@/lib/format-time";
import { SIGN_IN_TEXT } from "@/lib/portal-reset/sign-in";
import {
  ABORT_TEXT,
  reportSubject,
  type ResetReport,
} from "@/lib/portal-reset/report-email";
import { DetailsCard } from "./details-card";
import { EmailFrame, INK, MUTED, sectionPad } from "./email-frame";

// Spec 0023 AC-31: the report to the abort address, in the booking emails'
// frame. Times are UTC, because the address belongs to a team, not a
// learner. Nothing here is a value AC-30 forbids.

const when = (iso: string | null) =>
  iso === null ? "Not started" : formatEmailDateTime(new Date(iso), "UTC");

const small = {
  margin: 0,
  fontSize: "14px",
  lineHeight: 1.6,
  color: MUTED,
} as const;

const strong = { ...small, color: INK, fontWeight: 600 } as const;

const call = (f: {
  readonly method: string | null;
  readonly route: string | null;
}) => [f.method, f.route].filter((p) => p !== null && p !== "").join(" ");

const count = (r: ResetReport, key: string) => r.counts[key] ?? 0;

export function ResetReportEmail({ report }: { readonly report: ResetReport }) {
  const signIn =
    report.signInReason === null ? null : SIGN_IN_TEXT[report.signInReason];
  const intro =
    report.outcome === "held"
      ? "The reset could not sign in and is waiting. It tries again in 30 minutes unless a lab starts first."
      : report.outcome === "aborted" && report.reason !== null
        ? ABORT_TEXT[report.reason]
        : report.outcome === "incomplete"
          ? "The reset finished its passes, but something is left or failed."
          : "The reset found a kind of portal item that its list does not cover.";
  return (
    <EmailFrame
      title={reportSubject(report)}
      preview={intro}
      heading={reportSubject(report)}
      intro={intro}
    >
      <DetailsCard
        rows={[
          ["Testbed", report.testbedName],
          ["Workshop", report.domain],
          ...(signIn === null ? [] : [["Sign in problem", signIn] as const]),
          ["Lab ended", when(report.labEndedAt)],
          ["Started", when(report.startedAt)],
          ["Finished", when(report.finishedAt)],
          ["Deleted", String(count(report, "deleted"))],
          ["Changed", String(count(report, "changed"))],
          ["Failed", String(count(report, "failed"))],
          ["Fixed on retry", String(count(report, "resolved"))],
        ]}
      />
      {report.failures.length > 0 ? (
        <Section style={sectionPad(16, 4)}>
          <Text style={strong}>Not resolved</Text>
          {report.failures.map((f, i) => (
            <Text key={i} style={small}>
              {[
                f.stepKey,
                f.label,
                call(f),
                f.status === null ? null : String(f.status),
                f.message,
              ]
                .filter((p) => p !== null && p !== "")
                .join(" · ")}
            </Text>
          ))}
          {report.moreFailures > 0 ? (
            <Text style={small}>{`and ${report.moreFailures} more`}</Text>
          ) : null}
        </Section>
      ) : null}
      {report.routes.length > 0 ? (
        <Section style={sectionPad(16, 4)}>
          <Text style={strong}>New routes found</Text>
          {report.routes.map((r, i) => (
            <Text key={i} style={small}>
              {`${r.route ?? "unknown route"} · ${r.outcome} · found ${r.found}, deleted ${r.deleted}, left ${r.left}`}
            </Text>
          ))}
        </Section>
      ) : null}
      <Section style={sectionPad(16, 32)}>
        <Text style={small}>
          The full list of items is under Recent resets on the Nile Portal Reset
          page.
        </Text>
      </Section>
    </EmailFrame>
  );
}
