-- Spec 0002, build plan task 1: the core tables for slice 1.
-- Constraint and index names are a contract with server/db/constraint-errors.ts;
-- renaming one is a breaking change.

-- Shared updated_at maintenance.
create function hol_app.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- users ----------------------------------------------------------------------

create table hol_app.users (
  id uuid primary key default gen_random_uuid(),
  role text not null,
  name text not null,
  company text,
  email text not null,
  timezone text not null,
  status text not null default 'active',
  deactivated_at timestamptz,
  email_verified_at timestamptz,
  authentik_user_pk integer,
  authentik_pending_saga boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_role_check check (role in ('learner', 'admin')),
  constraint users_status_check check (status in ('active', 'deactivated')),
  constraint users_deactivated_at_matches_status
    check ((status = 'deactivated') = (deactivated_at is not null)),
  constraint users_name_trimmed check (name = btrim(name) and name <> ''),
  constraint users_email_trimmed check (email = btrim(email) and email <> ''),
  constraint users_authentik_user_pk_uq unique (authentik_user_pk)
);

create unique index users_email_lower_uq on hol_app.users (lower(email));

create trigger users_set_updated_at before update on hol_app.users
  for each row execute function hol_app.set_updated_at();

-- testbed_types --------------------------------------------------------------

create table hol_app.testbed_types (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  duration_value integer not null,
  duration_unit text not null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint testbed_types_name_trimmed check (name = btrim(name) and name <> ''),
  constraint testbed_types_duration_value_check check (duration_value >= 1),
  constraint testbed_types_duration_unit_check check (duration_unit in ('hours', 'days'))
);

create unique index testbed_types_name_lower_uq on hol_app.testbed_types (lower(name))
  where deleted_at is null;

create trigger testbed_types_set_updated_at before update on hol_app.testbed_types
  for each row execute function hol_app.set_updated_at();

-- testbeds -------------------------------------------------------------------

create table hol_app.testbeds (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null,
  testbed_type_id uuid not null
    constraint testbeds_testbed_type_id_fkey references hol_app.testbed_types (id) on delete restrict,
  portal_url text not null,
  lms_url text not null,
  authentik_group_pk uuid,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint testbeds_name_trimmed check (name = btrim(name) and name <> ''),
  constraint testbeds_slug_format
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 50),
  constraint testbeds_slug_uq unique (slug)
);

create unique index testbeds_name_lower_uq on hol_app.testbeds (lower(name))
  where deleted_at is null;
create index testbeds_testbed_type_id_idx on hol_app.testbeds (testbed_type_id);

create function hol_app.testbeds_slug_immutable() returns trigger
language plpgsql as $$
begin
  if new.slug is distinct from old.slug then
    raise exception 'testbeds.slug cannot change' using errcode = 'check_violation',
      constraint = 'testbeds_slug_immutable';
  end if;
  return new;
end $$;

create trigger testbeds_slug_immutable before update on hol_app.testbeds
  for each row execute function hol_app.testbeds_slug_immutable();

create trigger testbeds_set_updated_at before update on hol_app.testbeds
  for each row execute function hol_app.set_updated_at();

-- testbed_clients ------------------------------------------------------------

create table hol_app.testbed_clients (
  id uuid primary key default gen_random_uuid(),
  testbed_id uuid not null
    constraint testbed_clients_testbed_id_fkey references hol_app.testbeds (id) on delete cascade,
  kind text not null,
  name text not null,
  url text not null,
  position integer not null,
  created_at timestamptz not null default now(),
  constraint testbed_clients_kind_check check (kind in ('wired', 'wireless')),
  constraint testbed_clients_name_trimmed check (name = btrim(name) and name <> ''),
  constraint testbed_clients_position_check check (position >= 0),
  constraint testbed_clients_position_uq unique (testbed_id, position)
);

-- bookings -------------------------------------------------------------------

create table hol_app.bookings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null
    constraint bookings_user_id_fkey references hol_app.users (id) on delete restrict,
  testbed_id uuid not null
    constraint bookings_testbed_id_fkey references hol_app.testbeds (id) on delete restrict,
  testbed_type_id uuid not null
    constraint bookings_testbed_type_id_fkey references hol_app.testbed_types (id) on delete restrict,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null,
  version integer not null default 1,
  calendar_event_id text,
  cancelled_at timestamptz,
  cancelled_by_user_id uuid
    constraint bookings_cancelled_by_user_id_fkey references hol_app.users (id) on delete restrict,
  cancel_source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bookings_status_check
    check (status in ('provisioning', 'confirmed', 'cancelled', 'completed')),
  constraint bookings_starts_on_half_hour
    check (starts_at = date_bin('30 minutes', starts_at, timestamptz '2000-01-01 00:00:00+00')),
  constraint bookings_ends_after_starts check (ends_at > starts_at),
  constraint bookings_cancel_source_check
    check (cancel_source in ('learner', 'admin', 'deactivation')),
  constraint bookings_cancel_fields_together
    check ((cancelled_at is null) = (cancel_source is null)),
  constraint bookings_cancel_only_when_cancelled
    check ((status = 'cancelled') = (cancelled_at is not null)),
  constraint bookings_cancelled_by_needs_source
    check (cancelled_by_user_id is null or cancel_source is not null),
  constraint bookings_no_overlap exclude using gist (
    testbed_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status in ('provisioning', 'confirmed'))
);

create unique index bookings_one_live_per_user on hol_app.bookings (user_id)
  where status in ('provisioning', 'confirmed');
create index bookings_testbed_id_starts_at_idx on hol_app.bookings (testbed_id, starts_at);
create index bookings_user_id_starts_at_idx on hol_app.bookings (user_id, starts_at desc);
create index bookings_testbed_type_id_idx on hol_app.bookings (testbed_type_id);
create index bookings_cancelled_by_user_id_idx on hol_app.bookings (cancelled_by_user_id);
create index bookings_live_ends_at_idx on hol_app.bookings (ends_at)
  where status in ('provisioning', 'confirmed');
create index bookings_provisioning_created_at_idx on hol_app.bookings (created_at)
  where status = 'provisioning';

-- version is owned by this trigger: callers cannot set it. It rises by one on
-- every change a calendar event reflects (reschedule, cancel), and stays put
-- for confirm and complete.
create function hol_app.bookings_version_bump() returns trigger
language plpgsql as $$
begin
  if (new.starts_at, new.ends_at, new.testbed_id, new.status)
       is distinct from (old.starts_at, old.ends_at, old.testbed_id, old.status)
     and not (old.status = 'confirmed' and new.status = 'completed')
     and not (old.status = 'provisioning' and new.status = 'confirmed') then
    new.version := old.version + 1;
  else
    new.version := old.version;
  end if;
  return new;
end $$;

create trigger bookings_version_bump before update on hol_app.bookings
  for each row execute function hol_app.bookings_version_bump();

create trigger bookings_set_updated_at before update on hol_app.bookings
  for each row execute function hol_app.set_updated_at();

-- jobs -----------------------------------------------------------------------

create table hol_app.jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  payload jsonb not null,
  run_at timestamptz not null default now(),
  status text not null default 'pending',
  attempts integer not null default 0,
  locked_until timestamptz,
  last_error text,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint jobs_kind_check check (kind in ('send_email', 'calendar_upsert', 'calendar_delete')),
  constraint jobs_status_check check (status in ('pending', 'running', 'done', 'failed')),
  constraint jobs_attempts_check check (attempts between 0 and 8),
  constraint jobs_idempotency_key_uq unique (idempotency_key)
);

create index jobs_pending_run_at_idx on hol_app.jobs (run_at) where status = 'pending';
create index jobs_running_locked_until_idx on hol_app.jobs (locked_until)
  where status = 'running';

create trigger jobs_set_updated_at before update on hol_app.jobs
  for each row execute function hol_app.set_updated_at();

-- RLS on, no policies: only the owner (hol_app) reads or writes. -------------

alter table hol_app.users enable row level security;
alter table hol_app.testbed_types enable row level security;
alter table hol_app.testbeds enable row level security;
alter table hol_app.testbed_clients enable row level security;
alter table hol_app.bookings enable row level security;
alter table hol_app.jobs enable row level security;
alter table hol_app.kysely_migration enable row level security;
alter table hol_app.kysely_migration_lock enable row level security;
