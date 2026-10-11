// The Nile sign off from the emails, last on every learner page (spec 0009
// AC-5). The link is always underlined: color alone gives only 1.2:1 against
// the text around it.
export function LearnerFooter() {
  // Display only, not a booking, slot, or access decision, so the server
  // clock is fine here (not dbNow()).
  const year = new Date().getUTCFullYear();
  return (
    <footer className="border-t bg-cloud-mist px-7 py-5 text-pill leading-[1.6] text-fg2">
      <p>
        Nile Hands-On Labs ·{" "}
        <a
          href="https://www.nilesecure.com"
          className="text-primary underline underline-offset-2"
        >
          nilesecure.com
        </a>
      </p>
      <p>Copyright © {year} Nile. All rights reserved.</p>
    </footer>
  );
}
