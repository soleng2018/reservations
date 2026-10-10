// The first thing Tab reaches on every admin and learner page (AC-14).
// It jumps to the page's one <main id="content">.
export function SkipLink() {
  return (
    <a
      href="#content"
      className="sr-only rounded-full bg-primary px-4 py-2 text-sm font-bold text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-60"
    >
      Skip to content
    </a>
  );
}
