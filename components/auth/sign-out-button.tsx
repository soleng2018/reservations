import { signOut } from "@/app/auth/actions";

export function SignOutButton() {
  return (
    <form action={signOut}>
      <button type="submit" className="text-sm underline">
        Sign out
      </button>
    </form>
  );
}
