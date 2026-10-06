# Stack Architecture Research - 2026-10-04

## 1. InsForge Self-Hosting

**Self-Hosted Docker Compose:** Yes, fully supported. Requires Docker with Compose v2. Configuration via `.env` file with `API_BASE_URL` and `VITE_API_BASE_URL`.

**Included Components:** PostgreSQL database, REST API (PostgREST), Authentication system, S3-compatible file storage, Edge Functions (Deno-based serverless). Supports multiple projects with separate containers/volumes via `COMPOSE_PROJECT_NAME` and custom ports.

**Scheduled Jobs (Cron/Schedules):** Unconfirmed in self-hosted documentation.

**External OIDC for Row Level Security:** Unconfirmed. Documentation references authentication but not specifically external OIDC provider support or generic OIDC JWT usage for RLS.

**Admin/API Key Access:** References `ACCESS_API_KEY` and `ACCESS_ANON_KEY` environment variables; specific direct Postgres connection string availability unconfirmed.

**Sources:**
- [InsForge GitHub Repository](https://github.com/InsForge/InsForge)
- [RepoCloud - InsForge](https://repocloud.io/details/InsForge/)

---

## 2. Authentik API Tokens and RBAC (Current Release)

**Token/User Binding:** Yes, API tokens are tied to service accounts and subject to RBAC role permissions. Same permission assignment as regular users (groups, roles, object permissions, app bindings).

**Permission Scoping:** Permissions can be scoped per object using `object_pk` parameter. "Least privilege" recommended—grant only required permissions.

**Superuser/Admin Group Exclusion:** Unconfirmed. Documentation does not specify `is_superuser` flag or object-level exclusion of admin groups (e.g., "manage users/groups but not superusers").

**Service Account Features:** Start with no special access. Can expire tokens. "View token's key" permission controls access to token values.

**API Reference:** RBAC roles list/update endpoints available via `rbac_permissions_roles_list`, `rbac_permissions_roles_update`.

**Sources:**
- [Authentik Service Accounts Documentation](https://docs.goauthentik.io/sys-mgmt/service-accounts/)
- [Authentik Blog - AI Agents Note (2026-03-16)](https://goauthentik.io/blog/2026-03-16-a-note-to-ai-agents-about-authentik/)
- [GitHub Issue #16858 - RBAC Permissions for Tokens](https://github.com/goauthentik/authentik/issues/16858)

---

## 3. Authentik API: User Recovery & Sessions

**Password Recovery Endpoints:**
- `POST /core/users/{id}/recovery/` → Creates temporary recovery link (core_users_recovery_create)
- `POST /core/users/{id}/recovery_email/` → Sends email with recovery link (core_users_recovery_email_create)
- Requires recovery flow on brand and email stage

**Authenticated Sessions Endpoints:**
- `GET /core/authenticated_sessions/` → List sessions (core_authenticated_sessions_list)
- `GET /core/authenticated_sessions/{uuid}/` → Retrieve session (core_authenticated_sessions_retrieve)
- Confirmed endpoints exist; delete endpoint unconfirmed in search results

**User Deactivation (is_active=false):** Unconfirmed whether deactivating ends active sessions.

**Time-Limited Group Membership:** Unconfirmed in documentation.

**Known Issue:** Recovery endpoint returned HTTP 405 in v2026.5.6 (GitHub Issue #24869).

**Sources:**
- [core_users_recovery_create API Reference](https://version-2024-8.goauthentik.io/developer-docs/api/reference/core-users-recovery-create)
- [core_users_recovery_email_create API Reference](https://docs.goauthentik.io/docs/developer-docs/api/reference/core-users-recovery-email-create)
- [core_authenticated_sessions_list API Reference](https://api.goauthentik.io/reference/core-authenticated-sessions-list/)
- [core_authenticated_sessions_retrieve API Reference](https://api.goauthentik.io/reference/core-authenticated-sessions-retrieve/)
- [GitHub Issue #24869 - Recovery Link Endpoint Error](https://github.com/goauthentik/authentik/issues/24869)

---

## 4. Authentik SAML Property Mappings

**Custom SAML Attribute Mapping:** Unconfirmed whether property mappings can emit transformed group names (e.g., "pod-tb1" → "NileAdministrators-tb1").

**Expression Context Access:** Unconfirmed whether expressions have access to `request.user`, `ak_groups`, or `user.ak_groups`.

*Note: Limited search results on this specific question; official Authentik SAML provider documentation would clarify.*

---

## 5. Cloudflare Access (Zero Trust)

**Browser-Rendered RDP & VNC:** GA status confirmed for VNC and SSH (October 2024). RDP browser rendering recently introduced/announced; specific GA confirmation unconfirmed for RDP.

**Browser-Based Rendering:** Cloudflare renders SSH, VNC, and RDP in browser using WebAssembly at edge. No client software required. Connection fully encrypted; Cloudflare cannot see session content.

**OIDC Claims in Policies:** Unconfirmed whether Access policies can match generic OIDC claims (e.g., "groups" claim from third-party IdP like Authentik).

**Session Revocation API:** Unconfirmed. No documented endpoint found for `POST /accounts/{account_id}/access/organizations/revoke_user` or equivalent.

**Browser-Rendered Session Termination:** Unconfirmed whether revoking Access sessions cuts already-open browser-rendered connections.

**App Session Duration:** Referenced in documentation but full configuration details unconfirmed.

**Sources:**
- [Cloudflare Blog - Browser-Based RDP](https://blog.cloudflare.com/browser-based-rdp/)
- [Browser VNC with Zero Trust Rules - Cloudflare TV](https://cloudflare.tv/event/browser-vnc-with-zero-trust-rules/PZ5EBmZ2)
- [Cloudflare One - Browser-Rendered Terminal Docs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/non-http/browser-rendering/)
- [Cloudflare Access Product Page](https://www.cloudflare.com/sase/products/access/)

---

## 6. Next.js Auth Library Status (2026)

**Not researched due to budget constraints.** Prioritized questions 1–5 per instructions.

Estimated answer requires verification of:
- Auth.js (NextAuth v5) maintenance and stability
- Better Auth generic OIDC support
- Next.js 16 compatibility (proxy.ts vs middleware.ts)

---

## 7. Gmail API & Google Calendar

**Not researched due to budget constraints.** Prioritized questions 1–5 per instructions.

Estimated answer requires verification of:
- Gmail API domain-wide delegation with service account
- MIME message sending with HTML + iCalendar METHOD:REQUEST/CANCEL
- Google Calendar API sendUpdates behavior

---

## Research Notes

- **Budget Used:** 7 web searches, 2 page fetches (max: 7 searches, 10 fetches)
- **Prioritization Applied:** Questions 1, 2, 3, 5 given primary focus per user instructions
- **Unconfirmed Items:** Marked throughout; require consultation with official documentation or support teams
- **Search Date:** 2026-10-04
