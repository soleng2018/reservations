import type { Metadata } from "next";
import { PlusIcon } from "lucide-react";
import { DataTable } from "@/components/admin/data-table";
import { FormDialog } from "@/components/admin/form-dialog";
import { PageBody } from "@/components/admin/page-body";
import { PageHeader } from "@/components/admin/page-header";
import { TestbedTypeFields } from "@/components/admin/testbed-type-fields";
import { Button } from "@/components/ui/button";
import { formatDuration } from "@/lib/duration";
import { requireAdmin } from "@/server/auth/require";
import { listTestbedTypes } from "@/server/catalog/testbed-types";
import { db } from "@/server/db";
import { createTestbedTypeAction } from "../actions";

export const metadata: Metadata = { title: "Testbed Types" };

// Spec 0005 AC-12 (spec 0004 AC-1): list and create. Edit and delete come
// with feature 7.
export default async function TestbedTypesPage() {
  await requireAdmin();
  const types = await listTestbedTypes(db());
  const rows = types.map((t) => {
    const duration = formatDuration(t.durationValue, t.durationUnit);
    return {
      id: t.id,
      label: t.name,
      search: `${t.name} ${duration}`,
      cells: {
        name: (
          <span className="text-cell font-semibold text-fg1">{t.name}</span>
        ),
        duration,
      },
    };
  });

  return (
    <>
      <PageHeader
        section="testbed-types"
        action={
          <FormDialog
            trigger={
              <Button>
                <PlusIcon data-icon="inline-start" aria-hidden="true" />
                Add type
              </Button>
            }
            title="Add testbed type"
            action={createTestbedTypeAction}
          >
            <TestbedTypeFields />
          </FormDialog>
        }
      />
      <PageBody>
        <DataTable
          columns={[
            { key: "name", header: "Type" },
            { key: "duration", header: "Duration" },
          ]}
          rows={rows}
          noun={{ one: "testbed type", many: "testbed types" }}
          searchPlaceholder="Search testbed types…"
        />
      </PageBody>
    </>
  );
}
