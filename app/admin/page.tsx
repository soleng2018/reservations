import type { Metadata } from "next";
import { TestbedForm } from "@/components/admin/testbed-form";
import { TestbedTypeForm } from "@/components/admin/testbed-type-form";
import { SignOutButton } from "@/components/auth/sign-out-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireAdmin } from "@/server/auth/require";
import { listTestbeds } from "@/server/catalog/testbeds";
import { listTestbedTypes } from "@/server/catalog/testbed-types";
import { db } from "@/server/db";

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false },
};

const plural = (n: number, unit: string) =>
  `${n} ${n === 1 ? unit.replace(/s$/, "") : unit}`;

// The tracer console (spec 0004 AC-1, AC-2): create only, no edit or delete.
// Slice 2 replaces it with the console from the mock.
export default async function AdminHome() {
  const { user } = await requireAdmin();
  const conn = db();
  const [types, testbeds] = await Promise.all([
    listTestbedTypes(conn),
    listTestbeds(conn),
  ]);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 p-6 sm:p-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Admin console</h1>
          <p className="text-sm text-muted-foreground">
            Signed in as {user.name}.
          </p>
        </div>
        <SignOutButton />
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>New testbed type</CardTitle>
            <CardDescription>
              The lab length a booking of this type gets.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TestbedTypeForm />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Testbed types</CardTitle>
          </CardHeader>
          <CardContent>
            {types.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No testbed types yet. Create one to add testbeds.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-2 font-medium">Name</th>
                    <th className="py-2 font-medium">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {types.map((t) => (
                    <tr key={t.id} className="border-t">
                      <td className="py-2">{t.name}</td>
                      <td className="py-2">
                        {plural(t.durationValue, t.durationUnit)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>New testbed</CardTitle>
            <CardDescription>
              Saving also creates its Authentik access group.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TestbedForm
              types={types.map((t) => ({ value: t.id, label: t.name }))}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Testbeds</CardTitle>
          </CardHeader>
          <CardContent>
            {testbeds.length === 0 ? (
              <p className="text-sm text-muted-foreground">No testbeds yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-2 font-medium">Name</th>
                    <th className="py-2 font-medium">Type</th>
                    <th className="py-2 font-medium">Access group</th>
                  </tr>
                </thead>
                <tbody>
                  {testbeds.map((t) => (
                    <tr key={t.id} className="border-t">
                      <td className="py-2">{t.name}</td>
                      <td className="py-2">{t.typeName}</td>
                      <td className="py-2">
                        {t.groupReady ? `pod-${t.slug}` : "Not ready"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
