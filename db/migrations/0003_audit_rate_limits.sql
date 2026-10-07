-- Audit log and fixed window rate limits, shaped as in spec 0002 and landed
-- with feature 4, their first writer (spec 0003).

create table hol_app.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid,
  action text not null,
  target_type text not null,
  target_id text not null,
  summary text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  constraint audit_events_actor_user_id_fkey foreign key (actor_user_id)
    references hol_app.users (id),
  constraint audit_events_target_type_check check (
    target_type in ('testbed_type', 'testbed', 'api_key', 'user', 'booking', 'authentik_group')
  )
);
create index audit_events_created_at_idx on hol_app.audit_events (created_at desc);
create index audit_events_target_idx on hol_app.audit_events (target_type, target_id);
create index audit_events_actor_user_id_idx on hol_app.audit_events (actor_user_id);

-- Append only, whoever runs it (spec 0002 AC-7).
create function hol_app.audit_events_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_events is append only';
end $$;

create trigger audit_events_append_only
  before update or delete on hol_app.audit_events
  for each row execute function hol_app.audit_events_append_only();
create trigger audit_events_no_truncate
  before truncate on hol_app.audit_events
  for each statement execute function hol_app.audit_events_append_only();

create table hol_app.rate_limits (
  bucket_key text not null,
  window_start timestamptz not null,
  count integer not null,
  created_at timestamptz not null default now(),
  constraint rate_limits_pkey primary key (bucket_key, window_start)
);

alter table hol_app.audit_events enable row level security;
alter table hol_app.rate_limits enable row level security;
