import type { MetadataRoute } from "next";
import { appUrl } from "@/server/env";

// Per request, so `next build` never reads APP_URL (spec 0009 AC-9). It
// never names the unlisted admin entry; /admin is guarded, not secret.
export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/admin", "/api/"] },
    sitemap: `${appUrl()}/sitemap.xml`,
  };
}
