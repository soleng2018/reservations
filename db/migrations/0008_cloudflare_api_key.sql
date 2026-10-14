-- Spec 0012 AC-11, spec 0006 AC-12: a third API key type, CLOUDFLARE, which
-- holds the token the worker uses for the Cloudflare Access revoke. At most
-- one live CLOUDFLARE key exists, so the worker never has to choose. Constraint
-- and index names are a contract with server/db/constraint-errors.ts.

alter table hol_app.api_keys drop constraint api_keys_type_check;
alter table hol_app.api_keys add constraint api_keys_type_check
  check (type in ('IDP', 'AI', 'CLOUDFLARE'));

create unique index api_keys_one_cloudflare_uq on hol_app.api_keys (type)
  where type = 'CLOUDFLARE' and deleted_at is null;
