import Link from "next/link";
import type { BookState } from "@/app/book/actions";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatDateTime } from "@/lib/format-time";

type Booked = Extract<BookState, { kind: "booked" }>;

// AC-6: rendered from the action's return state, never from a URL, and with
// no lab links (feature 14 adds them once the email is verified).
export function BookingConfirmation({ booking }: { readonly booking: Booked }) {
  const rows = [
    ["Lab type", booking.typeName],
    ["Testbed", booking.testbedName],
    ["Starts", formatDateTime(new Date(booking.startsAt), booking.timezone)],
    ["Ends", formatDateTime(new Date(booking.endsAt), booking.timezone)],
  ] as const;
  return (
    <Card role="status" aria-live="polite">
      <CardHeader>
        <CardTitle>Your lab is booked</CardTitle>
        <CardDescription>
          Times are shown in {booking.timezone}.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          {rows.map(([term, value]) => (
            <div key={term} className="contents">
              <dt className="text-muted-foreground">{term}</dt>
              <dd className="font-medium">{value}</dd>
            </div>
          ))}
        </dl>
        {booking.newUser ? (
          <p className="text-sm">
            Check your email for a link to set your password.
          </p>
        ) : (
          <p className="text-sm">
            <Link href="/reservations" className="font-medium underline">
              Sign in to manage your reservation
            </Link>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
