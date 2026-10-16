-- Spec 0013 AC-1, AC-24: the GOOGLE API key (a service account key with
-- domain wide delegation, plus the mailbox and calendar it acts on) and the
-- email outbox. Constraint and index names are a contract with
-- server/db/constraint-errors.ts.

-- api_keys: a fourth type and its settings ----------------------------------

alter table hol_app.api_keys drop constraint api_keys_type_check;
alter table hol_app.api_keys add constraint api_keys_type_check
  check (type in ('IDP', 'AI', 'CLOUDFLARE', 'GOOGLE'));

alter table hol_app.api_keys
  -- The Workspace mailbox the service account acts as (the From address).
  add column sender_email text,
  -- The shared "HOL bookings" calendar.
  add column calendar_id text,
  -- Test addresses go here; null means they are suppressed.
  add column dev_inbox text,
  -- Gets a copy of every learner email; null means no Bcc.
  add column ops_bcc text;

alter table hol_app.api_keys add constraint api_keys_google_fields_check check (
  (type = 'GOOGLE') = (sender_email is not null and calendar_id is not null)
  and (type = 'GOOGLE' or (dev_inbox is null and ops_bcc is null))
);

create unique index api_keys_one_google_uq on hol_app.api_keys (type)
  where type = 'GOOGLE' and deleted_at is null;

-- email_messages: one row per email, written in the booking transaction -----

create table hol_app.email_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null
    constraint email_messages_user_id_fkey references hol_app.users (id) on delete restrict,
  booking_id uuid
    constraint email_messages_booking_id_fkey references hol_app.bookings (id) on delete restrict,
  booking_version integer,
  job_id uuid
    constraint email_messages_job_id_fkey references hol_app.jobs (id) on delete set null,
  kind text not null,
  -- The learner's address when queued.
  to_address text not null,
  -- The address it went to (differs only when rerouted to the dev inbox).
  sent_to text,
  -- As sent, before any "[dev] " prefix.
  subject text not null,
  -- What the email shows, so each email describes its own booking version.
  details jsonb not null,
  status text not null default 'queued',
  provider_message_id text,
  sent_at timestamptz,
  -- Fixed app messages only, never a token or a raw Google body.
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_messages_kind_check
    check (kind in ('welcome', 'booked', 'rescheduled', 'cancelled', 'reminder')),
  constraint email_messages_status_check
    check (status in ('queued', 'sent', 'failed', 'suppressed')),
  constraint email_messages_booking_version_together
    check ((booking_id is null) = (booking_version is null))
);

-- One per (booking, kind, version); also serves the version order lookup.
create unique index email_messages_one_per_version_uq
  on hol_app.email_messages (booking_id, kind, booking_version)
  where booking_id is not null;
create index email_messages_user_id_created_at_idx
  on hol_app.email_messages (user_id, created_at desc);
create index email_messages_job_id_idx on hol_app.email_messages (job_id);

create trigger email_messages_set_updated_at before update on hol_app.email_messages
  for each row execute function hol_app.set_updated_at();

-- RLS on, no policies: only the owner (hol_app) reads or writes.
alter table hol_app.email_messages enable row level security;
