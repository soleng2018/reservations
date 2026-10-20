import Link from "next/link";
import { HistoryIcon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Spec 0016 AC-9: a list row's link to its history in the Audit Log.
export function HistoryLink({
  href,
  name,
}: {
  readonly href: string;
  readonly name: string;
}) {
  return (
    <Link
      href={href}
      aria-label={`History for ${name}`}
      className={cn(buttonVariants({ variant: "outline", size: "icon" }))}
    >
      <HistoryIcon aria-hidden="true" />
    </Link>
  );
}
