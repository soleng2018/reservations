import type { Metadata } from "next";
import { KeyRoundIcon, PencilIcon, PlusIcon } from "lucide-react";
import { ApiKeyFields } from "@/components/admin/api-key-fields";
import { DataTable } from "@/components/admin/data-table";
import { FormDialog } from "@/components/admin/form-dialog";
import { PageBody } from "@/components/admin/page-body";
import { PageHeader } from "@/components/admin/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { API_KEY_MESSAGES, SECRET_MASK } from "@/lib/api-keys";
import type { ApiKeyType } from "@/lib/db-enums";
import { formatDay } from "@/lib/format-time";
import { requireAdmin } from "@/server/auth/require";
import { listApiKeys } from "@/server/catalog/api-keys";
import { db } from "@/server/db";
import { assertEncryptionEnv } from "@/server/env";
import { createApiKeyAction, updateApiKeyAction } from "../actions";

export const metadata: Metadata = { title: "API Keys" };

// The mock's blue for IDP, violet for AI.
const TYPE_TONE = {
  IDP: "info",
  AI: "accent",
} as const satisfies Record<ApiKeyType, "info" | "accent">;

// Spec 0006: list, search, add, edit, and delete IDP and AI credentials. The
// secret never leaves the server: rows carry no secret field, the Key value
// cell is a fixed mask, and there is no reveal or copy anywhere (AC-1, AC-8).
export default async function ApiKeysPage() {
  const { user } = await requireAdmin();
  const encryption = assertEncryptionEnv();
  if (!encryption.ok) {
    // The problem names a variable or a rule, never a key (AC-9).
    console.error(`API Keys: ${encryption.error}`);
    return <NotConfigured />;
  }

  const keys = await listApiKeys(db());
  const rows = keys.map((k) => {
    const changed = formatDay(k.secretUpdatedAt, user.timezone);
    return {
      id: k.id,
      label: k.name,
      search: `${k.name} ${k.type} ${k.baseUrl}`,
      cells: {
        name: (
          <span className="text-cell font-semibold text-fg1">{k.name}</span>
        ),
        type: <Badge tone={TYPE_TONE[k.type]}>{k.type}</Badge>,
        baseUrl: (
          <span className="font-mono text-sm break-all text-fg2">
            {k.baseUrl}
          </span>
        ),
        secret: (
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-sm text-fg2" aria-hidden="true">
              {SECRET_MASK}
            </span>
            <span className="sr-only">Key hidden.</span>
            <span className="text-xs text-fg3">Changed {changed}</span>
          </div>
        ),
      },
      actions: (
        <FormDialog
          trigger={
            <Button variant="outline" size="icon" aria-label={`Edit ${k.name}`}>
              <PencilIcon aria-hidden="true" />
            </Button>
          }
          title="Edit API Key"
          action={updateApiKeyAction.bind(null, k.id)}
        >
          <ApiKeyFields
            defaults={{ name: k.name, type: k.type, baseUrl: k.baseUrl }}
            lastChanged={changed}
          />
        </FormDialog>
      ),
    };
  });

  return (
    <>
      <PageHeader
        section="api-keys"
        action={
          <FormDialog
            trigger={
              <Button>
                <PlusIcon data-icon="inline-start" aria-hidden="true" />
                Add API key
              </Button>
            }
            title="Add API Key"
            action={createApiKeyAction}
          >
            <ApiKeyFields />
          </FormDialog>
        }
      />
      <PageBody>
        <DataTable
          columns={[
            { key: "name", header: "Name" },
            { key: "type", header: "Type" },
            { key: "baseUrl", header: "Base URL" },
            { key: "secret", header: "Key value" },
          ]}
          rows={rows}
          noun={{ one: "API key", many: "API keys" }}
          searchPlaceholder="Search API keys…"
        />
      </PageBody>
    </>
  );
}

// AC-9: without a valid keyring nothing can be saved, so the page shows why
// instead of the table, and offers no Add action.
function NotConfigured() {
  return (
    <>
      <PageHeader section="api-keys" />
      <PageBody>
        <Empty
          role="alert"
          className="rounded-xl border border-solid bg-card shadow-xs"
        >
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <KeyRoundIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{API_KEY_MESSAGES.notConfiguredPage}</EmptyTitle>
            <EmptyDescription>
              Other parts of the console still work.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </PageBody>
    </>
  );
}
