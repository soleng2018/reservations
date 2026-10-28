-- Spec 0023: the Nile Portal reset engine. One run per ended lab and its
-- per item records (kept 30 days by the daily purge), the send_reset_report
-- job kind, and the audit target type for a run. Constraint and index names
-- are a contract with server/db/constraint-errors.ts.

create table hol_app.portal_reset_runs (
  id uuid primary key default gen_random_uuid(),
  testbed_id uuid not null,
  booking_id uuid,
  ended_key text not null,
  event text not null,
  mode text not null,
  lab_ended_at timestamptz not null,
  due_at timestamptz not null,
  state text not null default 'queued',
  abort_reason text,
  sign_in_reason text,
  progress jsonb not null default '{}',
  resumes smallint not null default 0,
  lease_until timestamptz,
  counts jsonb not null default '{}',
  report_note text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  constraint portal_reset_runs_testbed_id_fkey foreign key (testbed_id)
    references hol_app.testbeds (id),
  constraint portal_reset_runs_booking_id_fkey foreign key (booking_id)
    references hol_app.bookings (id),
  constraint portal_reset_runs_ended_key_uq unique (ended_key),
  constraint portal_reset_runs_event_check
    check (event in ('lab_ended', 'ended_early', 'moved')),
  constraint portal_reset_runs_mode_check
    check (mode in ('dry_run', 'live')),
  constraint portal_reset_runs_state_check
    check (state in ('queued', 'running', 'held', 'done', 'incomplete', 'aborted')),
  constraint portal_reset_runs_abort_reason_check
    check (abort_reason in (
      'mode_off', 'sign_in_failed', 'tenant_mismatch', 'guard_stop',
      'lab_started', 'deadline', 'testbed_unavailable', 'invalid_list',
      'crashed'
    )),
  constraint portal_reset_runs_abort_state_check
    check ((state = 'aborted') = (abort_reason is not null)),
  constraint portal_reset_runs_sign_in_reason_check
    check (sign_in_reason in (
      'credential_failed', 'idp_rejected', 'browser_unavailable',
      'portal_unreachable', 'timeout', 'token_missing'
    )),
  constraint portal_reset_runs_resumes_check check (resumes between 0 and 3),
  constraint portal_reset_runs_report_note_check
    check (report_note in ('not_needed', 'no_address', 'queued'))
);

create index portal_reset_runs_claim_idx
  on hol_app.portal_reset_runs (state, due_at);
create index portal_reset_runs_finished_idx
  on hol_app.portal_reset_runs (finished_at);
create unique index portal_reset_runs_one_running_uq
  on hol_app.portal_reset_runs (testbed_id) where state = 'running';

create table hol_app.portal_reset_run_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  seq integer not null,
  step_key text not null,
  kind text not null,
  label text,
  item_id text,
  method text,
  route text,
  status integer,
  message text,
  pass smallint not null,
  resolved boolean not null default false,
  detail jsonb,
  created_at timestamptz not null default now(),
  constraint portal_reset_run_items_run_id_fkey foreign key (run_id)
    references hol_app.portal_reset_runs (id) on delete cascade,
  constraint portal_reset_run_items_seq_uq unique (run_id, seq),
  constraint portal_reset_run_items_step_key_check
    check (char_length(step_key) <= 80),
  constraint portal_reset_run_items_kind_check
    check (kind in (
      'deleted', 'changed', 'failed', 'would_delete', 'would_change',
      'route_found'
    )),
  constraint portal_reset_run_items_label_check
    check (label is null or char_length(label) <= 120),
  constraint portal_reset_run_items_item_id_check
    check (item_id is null or char_length(item_id) <= 200),
  constraint portal_reset_run_items_method_check
    check (method is null or method in ('GET', 'POST', 'PUT', 'DELETE')),
  constraint portal_reset_run_items_route_check
    check (route is null or char_length(route) <= 200),
  constraint portal_reset_run_items_message_check
    check (message is null or char_length(message) <= 300),
  constraint portal_reset_run_items_pass_check check (pass between 1 and 2)
);

alter table hol_app.jobs drop constraint jobs_kind_check;
alter table hol_app.jobs add constraint jobs_kind_check
  check (kind in (
    'send_email', 'calendar_upsert', 'calendar_delete', 'send_welcome',
    'cleanup_notify', 'send_reset_report'
  ));

alter table hol_app.audit_events drop constraint audit_events_target_type_check;
alter table hol_app.audit_events add constraint audit_events_target_type_check
  check (target_type in (
    'testbed_type', 'testbed', 'api_key', 'user', 'booking', 'authentik_group',
    'portal_reset_step', 'portal_reset_settings', 'portal_reset_run'
  ));

alter table hol_app.portal_reset_runs enable row level security;
alter table hol_app.portal_reset_run_items enable row level security;
