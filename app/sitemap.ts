import type { MetadataRoute } from "next";
import { appUrl } from "@/server/env";

// The one indexable page (spec 0009 AC-8). Per request, like robots.ts.
export const dynamic = "force-dynamic";

export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: `${appUrl()}/` }];
}
