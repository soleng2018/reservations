import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// The id the booking flow focuses when its screen changes (spec 0010 AC-14),
// so a screen reader hears the new screen's title.
export const BOOK_HEADING_ID = "book-heading";

// The eyebrow ("Step 1 of 3"), the screen's one <h1>, and an optional line
// under it, as in the mock.
export function StepHeading({
  eyebrow,
  title,
  subtitle,
  compact = false,
}: {
  readonly eyebrow: string;
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly compact?: boolean;
}) {
  return (
    <header className={cn("flex flex-col", compact ? "mb-3.5" : "mb-5.5")}>
      <p
        className={cn(
          "font-bold tracking-[0.06em] text-nile-blue uppercase",
          compact ? "mb-1.25 text-xs" : "mb-2 text-pill",
        )}
      >
        {eyebrow}
      </p>
      <h1
        id={BOOK_HEADING_ID}
        tabIndex={-1}
        className={cn(
          "font-semibold text-fg1",
          compact ? "text-[1.375rem] leading-tight" : "text-card-title",
        )}
      >
        {title}
      </h1>
      {subtitle ? <p className="mt-0.5 text-sub text-fg2">{subtitle}</p> : null}
    </header>
  );
}
