import type { Metadata } from "next";
import { PencilIcon, PlusIcon } from "lucide-react";
import { DataTable } from "@/components/admin/data-table";
import { DeleteFlow } from "@/components/admin/delete-flow";
import { FormDialog } from "@/components/admin/form-dialog";
import { PageBody } from "@/components/admin/page-body";
import { PageHeader } from "@/components/admin/page-header";
import { TestbedTypeFields } from "@/components/admin/testbed-type-fields";
import { Button } from "@/components/ui/button";
import { formatDuration } from "@/lib/duration";
import { requireAdmin } from "@/server/auth/require";
import { listTestbedTypes } from "@/server/catalog/testbed-types";
import { db } from "@/server/db";
import {
  checkTestbedTypeDelete,
  createTestbedTypeAction,
  deleteTestbedTypeAction,
  updateTestbedTypeAction,
} from "../actions";

export const metadata: Metadata = { title: "Testbed Types" };

const usedBy = (n: number) => `${n} testbed${n === 1 ? "" : "s"}`;

// Spec 0005 AC-12 plus feature 7: list, search, add, edit, and delete, with
// how many testbeds use each type.
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
        usage: usedBy(t.testbedCount),
      },
      actions: (
        <>
          <FormDialog
            trigger={
              <Button
                variant="outline"
                size="icon"
                aria-label={`Edit ${t.name}`}
              >
                <PencilIcon aria-hidden="true" />
              </Button>
            }
            title="Edit testbed type"
            action={updateTestbedTypeAction.bind(null, t.id)}
          >
            <TestbedTypeFields
              defaults={{
                name: t.name,
                durationValue: t.durationValue,
                durationUnit: t.durationUnit,
              }}
            />
          </FormDialog>
          <DeleteFlow
            kind="testbed_type"
            id={t.id}
            label={t.name}
            check={checkTestbedTypeDelete}
            remove={deleteTestbedTypeAction}
          />
        </>
      ),
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
            { key: "usage", header: "Used by" },
          ]}
          rows={rows}
          noun={{ one: "testbed type", many: "testbed types" }}
          searchPlaceholder="Search testbed types…"
        />
      </PageBody>
    </>
  );
}
