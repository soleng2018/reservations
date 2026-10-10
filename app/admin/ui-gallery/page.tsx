import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageBody } from "@/components/admin/page-body";
import { PageHeader } from "@/components/admin/page-header";
import { UiGallery } from "@/components/admin/ui-gallery";
import { requireAdmin } from "@/server/auth/require";
import { isProduction } from "@/server/env";

export const metadata: Metadata = { title: "UI Gallery" };

// Spec 0005 AC-13: a dev reference, admin only, and not in production.
export default async function UiGalleryPage() {
  await requireAdmin();
  if (isProduction()) notFound();
  return (
    <>
      <PageHeader
        title="UI Gallery"
        subtitle="Every base piece with sample data. Not available in production."
      />
      <PageBody>
        <UiGallery />
      </PageBody>
    </>
  );
}
