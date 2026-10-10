import type { Metadata } from "next";
import { PlusIcon } from "lucide-react";
import { DataTable } from "@/components/admin/data-table";
import { FormDialog } from "@/components/admin/form-dialog";
import { PageBody } from "@/components/admin/page-body";
import { PageHeader } from "@/components/admin/page-header";
import { TestbedFields } from "@/components/admin/testbed-fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toneFor } from "@/lib/badge-tones";
import { requireAdmin } from "@/server/auth/require";
import { listTestbeds } from "@/server/catalog/testbeds";
import { listTestbedTypes } from "@/server/catalog/testbed-types";
import { db } from "@/server/db";
import { createTestbedAction } from "../actions";

export const metadata: Metadata = { title: "Testbeds" };

// Spec 0005 AC-12 (spec 0004 AC-2): list and create. Edit and delete come
// with feature 9.
export default async function TestbedsPage() {
  await requireAdmin();
  const conn = db();
  const [testbeds, types] = await Promise.all([
    listTestbeds(conn),
    listTestbedTypes(conn),
  ]);
  const rows = testbeds.map((t) => {
    const group = t.groupReady ? `pod-${t.slug}` : "Not ready";
    return {
      id: t.id,
      label: t.name,
      search: `${t.name} ${t.typeName} ${group}`,
      cells: {
        name: (
          <span className="text-cell font-semibold text-fg1">{t.name}</span>
        ),
        type: t.typeName,
        group: t.groupReady ? (
          group
        ) : (
          <Badge tone={toneFor(group)}>{group}</Badge>
        ),
      },
    };
  });

  return (
    <>
      <PageHeader
        section="testbeds"
        action={
          <FormDialog
            trigger={
              <Button>
                <PlusIcon data-icon="inline-start" aria-hidden="true" />
                Add testbed
              </Button>
            }
            title="Add testbed"
            action={createTestbedAction}
          >
            <TestbedFields
              types={types.map((t) => ({ value: t.id, label: t.name }))}
            />
          </FormDialog>
        }
      />
      <PageBody>
        <DataTable
          columns={[
            { key: "name", header: "Name" },
            { key: "type", header: "Testbed type" },
            { key: "group", header: "Access group" },
          ]}
          rows={rows}
          noun={{ one: "testbed", many: "testbeds" }}
          searchPlaceholder="Search by name, type, or access group…"
        />
      </PageBody>
    </>
  );
}
