import "server-only";
import { Section, Text } from "react-email";
import {
  LAB_LOGIN_HEADING,
  LAB_LOGIN_TAG,
  LOGINS_TITLE,
  SAME_PASSWORD,
  WINDOW_NOTICE,
  WORK_EMAIL,
  labLoginBody,
} from "@/lib/two-logins-notice";
import { BLUE, INK, sectionPad } from "./email-frame";

// The same notice as components/reservations/two-logins-notice.tsx, in
// email safe blocks (solid fills, borders, no icons or flex). One copy in
// lib/two-logins-notice.ts. The orange and pale blue are email only values:
// an email client cannot read the app's CSS tokens.
const AMBER = "#FF6600";
const AMBER_BG = "#FFE7D4";
const BLUE_BG = "#EEF4FE";
const BLUE_DARK = "#0A3C87";

const mono = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
};

export function TwoLoginsNotice({
  nileLogin,
}: {
  readonly nileLogin: string | null;
}) {
  return (
    <Section style={sectionPad(20, 4)}>
      <Section
        style={{
          background: AMBER_BG,
          border: `2px solid ${AMBER}`,
          borderRadius: "12px",
          padding: "14px 16px",
        }}
      >
        <Text style={{ margin: 0, fontSize: "16px", fontWeight: 800 }}>
          {WINDOW_NOTICE.title}
        </Text>
        <Text style={{ margin: "2px 0 0", fontSize: "14px" }}>
          {WINDOW_NOTICE.body}
        </Text>
      </Section>
      <Section
        style={{
          marginTop: "12px",
          border: `2px solid ${BLUE}`,
          borderRadius: "12px",
          overflow: "hidden",
        }}
      >
        <Text
          style={{
            margin: 0,
            padding: "10px 16px",
            background: BLUE,
            color: "#FFFFFF",
            fontSize: "16px",
            fontWeight: 800,
          }}
        >
          {LOGINS_TITLE}
        </Text>
        <Section style={{ padding: "14px 16px 0" }}>
          <Login
            n="1"
            heading={WORK_EMAIL.heading}
            tag={WORK_EMAIL.tag}
            body={WORK_EMAIL.body}
          />
          <Login
            n="2"
            heading={LAB_LOGIN_HEADING}
            tag={LAB_LOGIN_TAG}
            body={labLoginBody(nileLogin)}
            address={nileLogin}
          />
        </Section>
        <Section style={{ padding: "0 16px 14px" }}>
          <Text
            style={{
              margin: 0,
              padding: "11px 14px",
              background: INK,
              color: "#FFFFFF",
              borderRadius: "10px",
              fontSize: "15px",
              fontWeight: 700,
              textAlign: "center",
            }}
          >
            {SAME_PASSWORD}
          </Text>
        </Section>
      </Section>
    </Section>
  );
}

function Login({
  n,
  heading,
  tag,
  body,
  address = null,
}: {
  readonly n: string;
  readonly heading: string;
  readonly tag: string;
  readonly body: string;
  readonly address?: string | null;
}) {
  return (
    <Section
      style={{
        background: BLUE_BG,
        borderRadius: "10px",
        padding: "12px 14px",
        marginBottom: "10px",
      }}
    >
      <Text style={{ margin: 0, fontSize: "15px", fontWeight: 700 }}>
        {n}. {heading}
      </Text>
      <Text
        style={{
          margin: "2px 0 0",
          fontSize: "12px",
          fontWeight: 700,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: BLUE_DARK,
        }}
      >
        {tag}
      </Text>
      <Text style={{ margin: "4px 0 0", fontSize: "14px", lineHeight: 1.45 }}>
        {body}
      </Text>
      {address === null ? null : (
        <Text
          style={{
            margin: "4px 0 0",
            fontSize: "14px",
            fontWeight: 600,
            color: BLUE_DARK,
            ...mono,
          }}
        >
          {address}
        </Text>
      )}
    </Section>
  );
}
