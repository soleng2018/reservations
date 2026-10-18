import "server-only";
import { Heading, Link, Section, Text } from "react-email";
import {
  emailEnd,
  emailStart,
  manageUrl,
  type BookingEmailDetails,
} from "@/lib/booking-email";
import { CtaButton } from "./cta-button";
import { DetailsCard } from "./details-card";
import { BLUE, EmailFrame, LINE, MUTED, sectionPad } from "./email-frame";

// Spec 0013 AC-12: the booked and rescheduled email, after
// context/Nile HOL Lab Access Email Standalone.html.

const PREVIEW =
  "Your lab is reserved. Access links and session details inside.";

// AC-12 (amended 2026-10-16): the rescheduled email has its own intro.
const intro = (kind: "booked" | "rescheduled", name: string) =>
  kind === "booked"
    ? `Hi ${name}, your reservation is confirmed. The links below become active at your start time and stop working when your session ends. The calendar invite attached to this email holds the same details.`
    : `Hi ${name}, your reservation was moved. Here are the new details. The links below become active at your new start time and stop working when your session ends. The calendar invite attached to this email moves the event in your calendar.`;

const linkLabel = {
  portal: "Open the portal for this testbed",
  lms: "Open the lab guide",
  wireless: "Open the wireless client",
  wired: "Open the wired client",
} as const;

export function LabAccessEmail({
  kind,
  details,
}: {
  readonly kind: "booked" | "rescheduled";
  readonly details: BookingEmailDetails;
}) {
  const links = details.links;
  const rows = links
    ? [
        { title: "Nile Portal", label: linkLabel.portal, url: links.portalUrl },
        { title: "LMS course", label: linkLabel.lms, url: links.lmsUrl },
        ...links.clients.map((c) => ({
          title: c.name,
          label: linkLabel[c.kind],
          url: c.url,
        })),
      ]
    : [];
  return (
    <EmailFrame
      title="Your Nile Hands-On Lab access"
      preview={PREVIEW}
      heading={
        kind === "booked"
          ? "Your lab access is ready"
          : "Your reservation was rescheduled"
      }
      intro={intro(kind, details.learnerName)}
    >
      <DetailsCard
        rows={[
          ["Lab type", details.labTypeName],
          ["Testbed", details.testbedName],
          ["Starts", emailStart(details)],
          ["Ends", emailEnd(details)],
        ]}
      />
      <Section style={sectionPad(24, 4)}>
        <Heading
          as="h2"
          style={{ margin: 0, fontSize: "18px", fontWeight: 600 }}
        >
          Lab access
        </Heading>
      </Section>
      <Section style={{ ...sectionPad(8, 0), fontSize: "15px" }}>
        {rows.map((r, i) => (
          <Section
            key={`${r.title}-${i}`}
            style={{
              padding: "12px 0",
              borderBottom:
                i < rows.length - 1 ? `1px solid ${LINE}` : undefined,
            }}
          >
            <Text style={{ margin: 0, fontWeight: 600, fontSize: "15px" }}>
              {r.title}
            </Text>
            <Link
              href={r.url}
              style={{ color: BLUE, textDecoration: "none", fontSize: "14px" }}
            >
              {r.label}
            </Link>
          </Section>
        ))}
      </Section>
      {/* AC-12 (amended 2026-10-16): only for an account this booking
          created, since only then was its welcome email queued. */}
      {kind === "booked" && details.newAccount ? (
        <Section style={sectionPad(20, 4)}>
          <Section
            style={{
              border: `1px solid ${LINE}`,
              borderRadius: "12px",
              padding: "16px 20px",
            }}
          >
            <Text style={{ margin: 0, fontSize: "14px", fontWeight: 600 }}>
              Set your password
            </Text>
            <Text
              style={{
                margin: "4px 0 0",
                fontSize: "13px",
                lineHeight: 1.5,
                color: MUTED,
              }}
            >
              You will receive a separate email with a link to set your
              password. Use it with this email address to reschedule or cancel.
            </Text>
          </Section>
        </Section>
      ) : null}
      <CtaButton href={manageUrl(details)}>Manage my reservation</CtaButton>
      <Section
        style={{
          ...sectionPad(16, 32),
          fontSize: "14px",
          lineHeight: 1.6,
          color: MUTED,
        }}
      >
        Only one active reservation is allowed at a time. To change your time,
        reschedule from the link above before your session starts.
      </Section>
    </EmailFrame>
  );
}
