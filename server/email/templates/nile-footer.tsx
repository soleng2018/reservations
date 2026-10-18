import "server-only";
import { Link, Section } from "react-email";

// Spec 0013 AC-12, AC-13: the fixed footer of both standalone files.
export function NileFooter() {
  return (
    <Section
      style={{
        padding: "20px 36px",
        background: "#F6F8FB",
        borderTop: "1px solid #DCE3ED",
        borderRadius: "0 0 16px 16px",
        fontSize: "12.5px",
        lineHeight: 1.6,
        color: "#4D626C",
      }}
    >
      Nile Hands-On Labs ·{" "}
      <Link
        href="https://www.nilesecure.com"
        style={{ color: "#0E4EAF", textDecoration: "none" }}
      >
        nilesecure.com
      </Link>
      <br />
      Copyright © 2026 Nile. All rights reserved.
    </Section>
  );
}
