-- Spec 0006 AC-11: API keys (the spec 0002 table) and a testbed's optional
-- IDP key. Constraint and index names are a contract with
-- server/db/constraint-errors.ts; renaming one is a breaking change.

create table hol_app.api_keys (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null,
  base_url text not null,
  -- AES-256-GCM through the app keyring, never plain text (spec 0006 AC-7).
  secret_ciphertext text not null,
  -- Changes only when the secret is replaced.
  secret_updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint api_keys_name_trimmed check (name = btrim(name) and name <> ''),
  constraint api_keys_type_check check (type in ('IDP', 'AI')),
  constraint api_keys_secret_ciphertext_check check (secret_ciphertext like 'v1:%')
);

create unique index api_keys_name_lower_uq on hol_app.api_keys (lower(name))
  where deleted_at is null;

create trigger api_keys_set_updated_at before update on hol_app.api_keys
  for each row execute function hol_app.set_updated_at();

alter table hol_app.api_keys enable row level security;

-- Null until feature 9 assigns an IDP; must name a live IDP key (checked in
-- the app, spec 0006 AC-5 and feature 9).
alter table hol_app.testbeds
  add column idp_api_key_id uuid
    constraint testbeds_idp_api_key_id_fkey references hol_app.api_keys (id) on delete restrict;

create index testbeds_idp_api_key_id_idx on hol_app.testbeds (idp_api_key_id);
