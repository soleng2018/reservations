import Link from "next/link";

// Placeholder landing until the guest booking slice lands. It links only to
// the learner sign in, never to the admin entry (AC-3).
export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">Nile Hands-On Lab</h1>
      <Link href="/reservations" className="font-medium underline">
        Manage an existing reservation
      </Link>
    </main>
  );
}
