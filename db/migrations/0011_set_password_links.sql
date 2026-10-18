-- Spec 0014: the app's own set password links. The email carries
-- <appUrl>/set-password/<token>; only sha256(token) is stored, so the app can
-- make a link work once, expire it, and end it when an admin fixes the
-- learner's email. Constraint and index names are a contract with
-- server/db/constraint-errors.ts.

create table hol_app.set_password_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null
    constraint set_password_links_user_id_fkey references hol_app.users (id) on delete cascade,
  -- The welcome email that carried this link (1:1, written together).
  email_message_id uuid not null
    constraint set_password_links_email_message_id_fkey references hol_app.email_messages (id) on delete cascade,
  -- sha256 of the raw token; the token itself is never stored.
  token_hash bytea not null,
  -- lower(users.email) when sent: a later email change ends the link.
  email text not null,
  expires_at timestamptz not null,
  ended_at timestamptz,
  ended_reason text,
  created_at timestamptz not null default now(),
  constraint set_password_links_email_message_id_uq unique (email_message_id),
  constraint set_password_links_token_hash_uq unique (token_hash),
  constraint set_password_links_ended_reason_check
    check (ended_reason in ('used', 'other_used', 'email_changed')),
  constraint set_password_links_ended_together
    check ((ended_at is null) = (ended_reason is null))
);

-- Ending every live link of a user (a click, an email change).
create index set_password_links_live_user_idx
  on hol_app.set_password_links (user_id) where ended_at is null;
-- The worker's purge, 30 days past expiry.
create index set_password_links_expires_at_idx
  on hol_app.set_password_links (expires_at);

-- RLS on, no policies: only the owner (hol_app) reads or writes.
alter table hol_app.set_password_links enable row level security;
