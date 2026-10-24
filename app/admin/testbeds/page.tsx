import type { Metadata } from "next";
import { PlusIcon } from "lucide-react";
import { DataTable } from "@/components/admin/data-table";
import { DeleteFlow } from "@/components/admin/delete-flow";
import { FormDialog } from "@/components/admin/form-dialog";
import { HistoryLink } from "@/components/admin/history-link";
import { PageBody } from "@/components/admin/page-body";
import { PageHeader } from "@/components/admin/page-header";
import { TestbedEditDialog } from "@/components/admin/testbed-edit-dialog";
import { TestbedFields } from "@/components/admin/testbed-fields";
import { Button } from "@/components/ui/button";
import { targetHistoryHref } from "@/lib/audit-log";
import { clientCountLabel, testbedSearchText } from "@/lib/testbeds";
import { requireAdmin } from "@/server/auth/require";
import { listIdpKeyOptions } from "@/server/catalog/api-keys";
import { listTestbedsForAdmin } from "@/server/catalog/testbeds";
import { listTestbedTypes } from "@/server/catalog/testbed-types";
import { db } from "@/server/db";
import {
  checkTestbedDelete,
  createTestbedAction,
  deleteTestbedAction,
  loadTestbedForEdit,
  updateTestbedAction,
} from "../actions";

export const metadata: Metadata = { title: "Testbeds" };

// Spec 0007: list, search, add, edit, and delete testbeds. The list carries
// each testbed's client count only; OS logins reach the browser solely
// through the edit dialog's load (AC-1, AC-3).
export default async function TestbedsPage() {
  await requireAdmin();
  const conn = db();
  const [testbeds, types, idps] = await Promise.all([
    listTestbedsForAdmin(conn),
    listTestbedTypes(conn),
    listIdpKeyOptions(conn),
  ]);
  const typeOptions = types.map((t) => ({ value: t.id, label: t.name }));
  const idpOptions = idps.map((k) => ({ value: k.id, label: k.name }));

  const rows = testbeds.map((t) => ({
    id: t.id,
    label: t.name,
    search: testbedSearchText(t),
    cells: {
      name: <span className="text-cell font-semibold text-fg1">{t.name}</span>,
      groupName: <span className="font-mono">{t.groupName}</span>,
      type: t.typeName,
      domain: <span className="font-mono">{t.domain}</span>,
      idp: t.idpName ?? (
        <>
          <span aria-hidden="true">—</span>
          <span className="sr-only">None</span>
        </>
      ),
      clients: clientCountLabel(t.clientCount),
    },
    actions: (
      <>
        <HistoryLink href={targetHistoryHref("testbed", t.id)} name={t.name} />
        <TestbedEditDialog
          id={t.id}
          name={t.name}
          types={typeOptions}
          idps={idpOptions}
          load={loadTestbedForEdit}
          action={updateTestbedAction.bind(null, t.id)}
        />
        <DeleteFlow
          kind="testbed"
          id={t.id}
          label={t.name}
          check={checkTestbedDelete}
          remove={deleteTestbedAction}
        />
      </>
    ),
  }));

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
            <TestbedFields types={typeOptions} idps={idpOptions} />
          </FormDialog>
        }
      />
      <PageBody>
        <DataTable
          columns={[
            { key: "name", header: "Name" },
            { key: "groupName", header: "Group Name" },
            { key: "type", header: "Testbed type" },
            { key: "domain", header: "Domain" },
            { key: "idp", header: "IDP" },
            { key: "clients", header: "Clients" },
          ]}
          rows={rows}
          noun={{ one: "testbed", many: "testbeds" }}
          searchPlaceholder="Search by name, group name, type, domain, or IDP…"
        />
      </PageBody>
    </>
  );
}
