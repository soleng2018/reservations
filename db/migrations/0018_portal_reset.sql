-- Spec 0022: the Nile Portal Reset list. One settings row (the abort email,
-- the reset mode, the version a Save checks) and the ordered steps a reset
-- runs. Constraint and index names are a contract with
-- server/db/constraint-errors.ts. The steps are seeded once from
-- db/seed/portal-reset-starting-list.json by the migrate process, not here.

create table hol_app.portal_reset_settings (
  id boolean primary key default true,
  abort_email text,
  mode text not null default 'off',
  -- Set by the Save that changes the mode (spec 0023 AC-2).
  mode_changed_at timestamptz,
  version integer not null default 1,
  seeded_at timestamptz,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  constraint portal_reset_settings_single_row check (id),
  constraint portal_reset_settings_abort_email_check
    check (abort_email is null or char_length(abort_email) <= 254),
  constraint portal_reset_settings_mode_check
    check (mode in ('off', 'dry_run', 'live')),
  constraint portal_reset_settings_version_check check (version >= 1),
  constraint portal_reset_settings_updated_by_fkey foreign key (updated_by)
    references hol_app.users (id) on delete set null
);
insert into hol_app.portal_reset_settings (id) values (true);

create table hol_app.portal_reset_steps (
  id uuid primary key default gen_random_uuid(),
  position integer not null,
  feature_name text not null,
  enabled boolean not null default true,
  definition jsonb not null,
  note text,
  -- The starting list entry this row came from.
  seed_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint portal_reset_steps_position_check check (position >= 1),
  -- Deferred so a reorder inside one transaction cannot trip on itself.
  constraint portal_reset_steps_position_uq unique (position)
    deferrable initially deferred,
  constraint portal_reset_steps_feature_name_check
    check (char_length(feature_name) between 1 and 60),
  constraint portal_reset_steps_definition_check
    check (jsonb_typeof(definition) = 'object'),
  constraint portal_reset_steps_definition_size_check
    check (octet_length(definition::text) <= 20000),
  constraint portal_reset_steps_note_check
    check (note is null or char_length(note) <= 300)
);
create unique index portal_reset_steps_feature_name_lower_uq
  on hol_app.portal_reset_steps (lower(feature_name));
create unique index portal_reset_steps_seed_key_uq
  on hol_app.portal_reset_steps (seed_key) where seed_key is not null;

alter table hol_app.audit_events drop constraint audit_events_target_type_check;
alter table hol_app.audit_events add constraint audit_events_target_type_check
  check (target_type in (
    'testbed_type', 'testbed', 'api_key', 'user', 'booking', 'authentik_group',
    'portal_reset_step', 'portal_reset_settings'
  ));

create trigger portal_reset_settings_set_updated_at
  before update on hol_app.portal_reset_settings
  for each row execute function hol_app.set_updated_at();
create trigger portal_reset_steps_set_updated_at
  before update on hol_app.portal_reset_steps
  for each row execute function hol_app.set_updated_at();

alter table hol_app.portal_reset_settings enable row level security;
alter table hol_app.portal_reset_steps enable row level security;
