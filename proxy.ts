import { NextResponse, type NextRequest } from "next/server";
import { adminEntryPath } from "@/server/env";

// The admin entry page lives at the unlisted ADMIN_ENTRY_PATH. Its real
// route is hidden, and admin pages are kept out of search engines (AC-3).
// This only hides the console: every admin page and action still calls
// requireAdmin().
const ENTRY_ROUTE = "/auth/admin-entry";

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const entry = adminEntryPath();

  if (pathname === ENTRY_ROUTE || pathname.startsWith(`${ENTRY_ROUTE}/`))
    return new NextResponse(null, { status: 404 });

  const res =
    pathname === entry
      ? NextResponse.rewrite(new URL(ENTRY_ROUTE, request.url))
      : NextResponse.next();
  if (
    pathname === entry ||
    pathname === "/admin" ||
    pathname.startsWith("/admin/")
  )
    res.headers.set("X-Robots-Tag", "noindex, nofollow");
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/).*)"],
};
