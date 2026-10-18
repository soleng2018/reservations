import "server-only";
import { Column, Row, Section } from "react-email";
import { LINE, MUTED, PAPER, sectionPad } from "./email-frame";

// Marks each row so the plain text part lays it out as "Label  Value"
// (server/email/compose.ts).
export const DETAILS_ROW = "details-row";

// Spec 0013 AC-12, AC-13: the grey card of labelled booking details.
export function DetailsCard({
  rows,
}: {
  readonly rows: readonly (readonly [label: string, value: string])[];
}) {
  return (
    <Section style={sectionPad(20, 8)}>
      <Section
        style={{
          background: PAPER,
          border: `1px solid ${LINE}`,
          borderRadius: "12px",
          padding: "18px 20px",
          fontSize: "14.5px",
          lineHeight: 1.5,
        }}
      >
        {rows.map(([label, value]) => (
          <Row key={label} className={DETAILS_ROW}>
            <Column style={{ padding: "5px 0", color: MUTED, width: "110px" }}>
              {label}
            </Column>
            <Column style={{ padding: "5px 0", fontWeight: 600 }}>
              {value}
            </Column>
          </Row>
        ))}
      </Section>
    </Section>
  );
}
