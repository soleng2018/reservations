import { PageBody } from "@/components/admin/page-body";
import { PageHeader } from "@/components/admin/page-header";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { navItem, type AdminSection } from "@/lib/admin-nav";

// A section that a later feature builds (spec 0005 AC-5): the shell header
// with no action, and an empty state.
export function ComingSoon({ section }: { readonly section: AdminSection }) {
  const Icon = navItem(section).icon;
  return (
    <>
      <PageHeader section={section} />
      <PageBody>
        <Empty className="rounded-xl border border-solid bg-card shadow-xs">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Icon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>Coming in a later release.</EmptyTitle>
            <EmptyDescription>This section is being built.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </PageBody>
    </>
  );
}
