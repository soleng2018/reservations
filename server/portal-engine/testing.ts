import "server-only";
import { err, ok } from "@/lib/result";
import type { PortalClient, PortalReply, PortalRequest } from "./portal";

// The in memory fake Nile Portal (spec 0023 "testing.ts"). One table per list
// route, the reply shapes the research saw, a write log, and `intercept` for
// the answers a test wants to force (a 404, a 5xx, a refusal). It is state
// by design: a test builds one, runs steps against it, and reads it back.

type Rec = Record<string, unknown>;

export type FakeState = {
  webhooks: Rec[];
  siems: Rec[];
  emailSubs: Rec[];
  ddns: Rec[];
  ssids: Rec[];
  guestAdvance: Rec[];
  sso: { pre: string; post: string } | null;
  clientConfigs: Rec[];
  policySets: Rec[];
  serviceProfiles: Rec[];
  groups: Rec[];
  segments: Rec[];
  radius: Rec[];
  portals: Rec[];
  nileRadiusSets: Rec[];
  nileRadiusConfig: { usable: boolean; tlsComplete: boolean };
  dhcp: Rec[];
  brandingRestores: number;
};

export type Write = {
  readonly method: PortalRequest["method"];
  readonly path: string;
  readonly body?: unknown;
};

export type Fake = {
  readonly state: FakeState;
  readonly portal: PortalClient;
  readonly writes: readonly Write[];
  readonly calls: readonly string[];
  // Return a reply to override the fake for one request.
  intercept: (req: PortalRequest) => PortalReply | undefined;
};

const reply = (status: number, body: unknown = {}): PortalReply => ({
  status,
  body,
});
const notFound = () => reply(404, { message: "Not found" });

// A tenant with something of every kind the 13 starting steps know, plus the
// system items that must survive.
export const populatedState = (): FakeState => ({
  webhooks: [{ id: "wh1", name: "Hook" }],
  siems: [{ id: "si1", name: "Splunk" }],
  emailSubs: [{ id: "em1" }],
  ddns: [{ id: "dd1", name: "ddns" }],
  ssids: [
    {
      id: "ssid-protected",
      instanceName: "Nile-Secure",
      ssid: { popTunnelUsed: true },
    },
    {
      id: "ssid-guest",
      instanceName: "Guest",
      ssid: { popTunnelUsed: false },
      enableInternalGuest: true,
    },
    {
      id: "ssid-lookalike",
      instanceName: "Nile-Secure",
      ssid: { popTunnelUsed: false },
    },
  ],
  guestAdvance: [{ id: "ga1", tenantId: "t1", advanceSettingsEnabled: true }],
  sso: { pre: "seg-a", post: "seg-b" },
  clientConfigs: [
    { clientConfig: { id: "cc-all", ruleType: "ALL" } },
    { clientConfig: { id: "cc1", ruleType: "MAC" } },
  ],
  policySets: [
    {
      id: "ps1",
      name: "Set",
      policies: [
        { id: "pol-sys", name: "System", policyAttribute: { isDefault: true } },
        { id: "pol1", name: "Mine", policyAttribute: { isDefault: false } },
      ],
    },
  ],
  serviceProfiles: [{ id: "sp1", name: "Profile" }],
  groups: [
    { id: "g1", name: "Mine", groupType: "User" },
    { id: "g-app", name: "App in use", groupType: "App", inPolicy: true },
    { id: "g-app2", name: "App free", groupType: "App" },
  ],
  segments: [{ id: "seg1", instanceName: "Seg" }],
  radius: [
    { id: "rad-nile", instanceName: "Nile RADIUS", cloudRadius: true },
    { id: "rad1", instanceName: "Mine", cloudRadius: false },
  ],
  portals: [{ id: "gp1", name: "Portal" }],
  nileRadiusSets: [
    {
      id: "nps1",
      name: "Default Network Policy",
      policies: [
        {
          id: "np-default",
          name: "Default",
          isDefault: true,
          authResult: "ACCEPT",
        },
        { id: "np1", name: "Mine", isDefault: false, authResult: "ACCEPT" },
      ],
    },
  ],
  nileRadiusConfig: { usable: true, tlsComplete: true },
  dhcp: [
    {
      id: "dh-nile",
      instanceName: "Nile DHCP",
      dhcpClient: { cloudDHCP: true, servers: [{ subnets: [{ id: "sn1" }] }] },
    },
    {
      id: "dh1",
      instanceName: "Mine",
      dhcpClient: { cloudDHCP: false, servers: [{ subnets: [] }] },
    },
  ],
  brandingRestores: 0,
});

export const baselineState = (): FakeState => ({
  ...populatedState(),
  webhooks: [],
  siems: [],
  emailSubs: [],
  ddns: [],
  ssids: (populatedState().ssids as Rec[]).slice(0, 1),
  guestAdvance: [{ id: "ga1", tenantId: "t1", advanceSettingsEnabled: false }],
  sso: null,
  clientConfigs: [],
  policySets: [
    {
      id: "ps1",
      name: "Set",
      policies: [
        { id: "pol-sys", name: "System", policyAttribute: { isDefault: true } },
      ],
    },
  ],
  serviceProfiles: [],
  groups: [
    { id: "g-app", name: "App in use", groupType: "App", inPolicy: true },
  ],
  segments: [],
  radius: (populatedState().radius as Rec[]).slice(0, 1),
  portals: [],
  nileRadiusSets: [
    {
      id: "nps1",
      name: "Default Network Policy",
      policies: [
        {
          id: "np-default",
          name: "Default",
          isDefault: true,
          authResult: "REJECT",
        },
      ],
    },
  ],
  nileRadiusConfig: { usable: false, tlsComplete: false },
  dhcp: [
    {
      id: "dh-nile",
      instanceName: "Nile DHCP",
      dhcpClient: { cloudDHCP: true, servers: [{ subnets: [] }] },
    },
  ],
});

const isRec = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function makeFake(state: FakeState = populatedState()): Fake {
  const writes: Write[] = [];
  const calls: string[] = [];
  const fake: Fake = {
    state,
    writes,
    calls,
    intercept: () => undefined,
    portal: {
      close: async () => undefined,
      call: async (req) => {
        calls.push(`${req.method} ${req.path}`);
        if (req.method !== "GET") writes.push(req);
        const forced = fake.intercept(req);
        if (forced) return ok(forced);
        return ok(handle(state, req));
      },
    },
  };
  return fake;
}

// A removal that answers 200, or 404 when the id is not there.
function removeFrom(rows: Rec[], id: string | undefined): PortalReply {
  const at = rows.findIndex((r) => r.id === id);
  if (at < 0) return notFound();
  rows.splice(at, 1);
  return reply(200);
}

function handle(s: FakeState, req: PortalRequest): PortalReply {
  const path = req.path.split("?")[0] ?? "";
  const seg = path.split("/").filter(Boolean);
  const at = (prefix: string) => path === prefix;
  const idAfter = (prefix: string) =>
    path.startsWith(`${prefix}/`)
      ? decodeURIComponent(path.slice(prefix.length + 1))
      : undefined;
  const get = req.method === "GET";
  const del = req.method === "DELETE";

  // Simple collections: GET list, DELETE one.
  const table = (
    prefix: string,
    rows: Rec[],
    wrap: (rows: Rec[]) => unknown,
    canDelete?: (row: Rec) => PortalReply | undefined,
  ): PortalReply | undefined => {
    if (at(prefix) && get) return reply(200, wrap(rows));
    const id = idAfter(prefix);
    if (id !== undefined && del) {
      const row = rows.find((r) => r.id === id);
      const refusal = row ? canDelete?.(row) : undefined;
      return refusal ?? removeFrom(rows, id);
    }
    return undefined;
  };
  const content = (rows: Rec[]) => ({ content: rows });
  const dataContent = (rows: Rec[]) => ({ data: { content: rows } });

  const simple =
    table("/api/v1/subscriptions/webhooks/config", s.webhooks, content) ??
    table("/api/v1/siems", s.siems, dataContent) ??
    table("/api/v1/subscriptions/email", s.emailSubs, content) ??
    table("/api/v1/dhcp/ddns/ddns-servers", s.ddns, dataContent) ??
    table("/api/v1/settings/ssids", s.ssids, dataContent) ??
    table("/api/v3/policy/service-profiles", s.serviceProfiles, content) ??
    table("/api/v3/policy/groups", s.groups, content, (row) =>
      row.inPolicy === true
        ? reply(400, { message: "Cannot delete, Group belongs to a Policy" })
        : undefined,
    ) ??
    table("/api/v1/settings/segments", s.segments, dataContent) ??
    table("/api/v1/settings/radius", s.radius, dataContent) ??
    table("/api/v1/portalconfig", s.portals, (rows) => rows);
  if (simple) return simple;

  if (at("/api/v1/guestpop/advance") && get) return reply(200, s.guestAdvance);
  if (path.startsWith("/api/v1/guestpop/advance/") && req.method === "PUT") {
    const row = s.guestAdvance.find((r) => r.id === seg[4]);
    if (!row || !isRec(req.body)) return notFound();
    row.advanceSettingsEnabled = req.body.advanceSettingsEnabled;
    return reply(200);
  }

  if (at("/api/v1/settings/sso-segment")) {
    if (get) {
      return reply(
        200,
        s.sso === null
          ? {}
          : {
              ssoSegment: {
                preTransactionSegment: s.sso.pre,
                postTransactionSegment: s.sso.post,
              },
            },
      );
    }
    if (del) {
      if (s.sso === null) return notFound();
      s.sso = null;
      return reply(200);
    }
  }
  if (at("/api/v1/client-configs")) {
    if (get) return reply(200, s.clientConfigs);
    if (del && isRec(req.body) && Array.isArray(req.body.ids)) {
      const ids: unknown[] = req.body.ids;
      const keep = s.clientConfigs.filter(
        (r) => !ids.includes((r.clientConfig as Rec).id),
      );
      s.clientConfigs.splice(0, s.clientConfigs.length, ...keep);
      return reply(200);
    }
  }

  if (at("/api/v3/policy/policysets") && get) {
    return reply(200, { content: s.policySets });
  }
  const rule = /^\/api\/v3\/policy\/policysets\/([^/]+)\/rules\/([^/]+)$/.exec(
    path,
  );
  if (rule && del) {
    const set = s.policySets.find((p) => p.id === rule[1]);
    return set ? removeFrom(set.policies as Rec[], rule[2]) : notFound();
  }

  if (at("/api/v1/cloudradius/policysets") && get) {
    return reply(200, s.nileRadiusSets);
  }
  const npol =
    /^\/api\/v1\/cloudradius\/policysets\/([^/]+)\/policies\/([^/]+)$/.exec(
      path,
    );
  if (npol) {
    const set = s.nileRadiusSets.find((p) => p.id === npol[1]);
    const rows = set ? (set.policies as Rec[]) : undefined;
    if (!rows) return notFound();
    if (del) return removeFrom(rows, npol[2]);
    if (req.method === "PUT" && isRec(req.body)) {
      const i = rows.findIndex((r) => r.id === npol[2]);
      if (i < 0) return notFound();
      rows[i] = req.body;
      return reply(200);
    }
  }
  if (at("/api/v1/cloudradius/config") && get) {
    return reply(200, {
      usable: s.nileRadiusConfig.usable,
      eapTLSConfig: { complete: s.nileRadiusConfig.tlsComplete },
    });
  }
  if (at("/api/v1/cloudradius/config/demo/keys") && del) {
    if (!s.nileRadiusConfig.usable && !s.nileRadiusConfig.tlsComplete) {
      return notFound();
    }
    s.nileRadiusConfig = { usable: false, tlsComplete: false };
    return reply(200);
  }

  if (at("/api/v1/settings/dhcp-clients") && get) {
    return reply(200, dataContent(s.dhcp));
  }
  const dh = idAfter("/api/v1/settings/dhcp-clients");
  if (dh !== undefined && del) return removeFrom(s.dhcp, dh);
  if (dh !== undefined && req.method === "PUT" && isRec(req.body)) {
    const i = s.dhcp.findIndex((r) => r.id === dh);
    if (i < 0) return notFound();
    s.dhcp[i] = req.body;
    return reply(200);
  }

  if (at("/api/v1/cloud-profile/value") && del) {
    s.brandingRestores += 1;
    return reply(200);
  }
  return notFound();
}

// A client whose every call fails the way a dead network does.
export const deadPortal: PortalClient = {
  close: async () => undefined,
  call: async () => err("network"),
};
