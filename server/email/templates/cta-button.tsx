import "server-only";
import { Button, Section } from "react-email";
import { sectionPad } from "./email-frame";

// The orange pill of both standalone files (the gradient, with a solid
// fallback for clients that drop background images).
export function CtaButton({
  href,
  children,
}: {
  readonly href: string;
  readonly children: string;
}) {
  return (
    <Section style={sectionPad(28, 8)}>
      <Button
        href={href}
        style={{
          display: "inline-block",
          padding: "14px 28px",
          borderRadius: "999px",
          background: "#FF6600",
          backgroundImage: "linear-gradient(90deg,#EC394C,#FF6600)",
          color: "#FFFFFF",
          fontSize: "15px",
          fontWeight: 700,
          textDecoration: "none",
        }}
      >
        {children}
      </Button>
    </Section>
  );
}
