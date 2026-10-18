import "server-only";
import type { CSSProperties, ReactNode } from "react";
import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Img,
  Preview,
  Section,
  Text,
} from "react-email";
import { NileFooter } from "./nile-footer";

// Spec 0013 AC-12, AC-13: the shared shell of every HOL email, rebuilt from
// context/Nile HOL Lab Access Email Standalone.html with its inline styles.
// The logo is the inline `cid:nile-logo` attachment server/email/compose.ts
// adds. Features 16 and 17 reuse it.

export const INK = "#001E2D";
export const MUTED = "#4D626C";
export const LINE = "#DCE3ED";
export const PAPER = "#F6F8FB";
export const BLUE = "#0E4EAF";

export const LOGO_CID = "nile-logo";

const pad = (top: number, bottom: number): CSSProperties => ({
  padding: `${top}px 36px ${bottom}px`,
});

export function EmailFrame({
  title,
  preview,
  heading,
  intro,
  children,
}: {
  readonly title: string;
  readonly preview: string;
  readonly heading: string;
  readonly intro: string;
  readonly children: ReactNode;
}) {
  return (
    <Html lang="en">
      <Head>
        <title>{title}</title>
      </Head>
      <Body
        style={{
          margin: 0,
          padding: 0,
          background: PAPER,
          fontFamily: "Inter,Arial,Helvetica,sans-serif",
          color: INK,
        }}
      >
        {/* Its own <title> would duplicate the real one. */}
        <Preview useTitleTag={false}>{preview}</Preview>
        <Section style={{ background: PAPER, padding: "32px 12px" }}>
          <Container
            style={{
              width: "100%",
              maxWidth: "600px",
              background: "#FFFFFF",
              border: `1px solid ${LINE}`,
              borderRadius: "16px",
            }}
          >
            <Section style={pad(28, 20)}>
              <Img
                src={`cid:${LOGO_CID}`}
                alt="Nile"
                width="61"
                height="30"
                style={{ display: "block", height: "30px", border: 0 }}
              />
            </Section>
            <Section style={pad(0, 0)}>
              <div
                style={{
                  height: "3px",
                  background: "linear-gradient(90deg,#0E4EAF,#EC394C,#FF6600)",
                  backgroundColor: BLUE,
                  borderRadius: "2px",
                }}
              />
            </Section>
            <Section style={pad(28, 8)}>
              <Text
                style={{
                  margin: 0,
                  fontSize: "12px",
                  fontWeight: 600,
                  letterSpacing: ".06em",
                  textTransform: "uppercase",
                  color: BLUE,
                }}
              >
                Nile Hands-On Labs
              </Text>
              <Heading
                as="h1"
                style={{
                  margin: "8px 0 12px",
                  fontSize: "28px",
                  lineHeight: 1.2,
                  fontWeight: 600,
                  color: INK,
                }}
              >
                {heading}
              </Heading>
              <Text
                style={{
                  margin: 0,
                  fontSize: "16px",
                  lineHeight: 1.6,
                  color: MUTED,
                }}
              >
                {intro}
              </Text>
            </Section>
            {children}
            <NileFooter />
          </Container>
        </Section>
      </Body>
    </Html>
  );
}

export const sectionPad = pad;
