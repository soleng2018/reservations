-- Spec 0019: the login each learner has per testbed domain (AC-3). One
-- Authentik user per learner; its username follows the booked domain, and
-- this table remembers each domain's login so a return gives the same one.
-- Constraint and index names are a contract with tests and later specs.
-- `learner_domain_logins_username_uq` arbitrates a race through
-- `on conflict do nothing`, so it needs no mapConstraintError entry.

set local lock_timeout = '5s';

create table hol_app.learner_domain_logins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null
    constraint learner_domain_logins_user_id_fkey references hol_app.users (id) on delete cascade,
  -- Lowercase copy of testbeds.domain at first use.
  domain text not null,
  -- The full login, lowercase.
  username text not null,
  -- Set to now() each time this login is made the Authentik username.
  used_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint learner_domain_logins_domain_lower
    check (domain = lower(domain) and domain <> ''),
  constraint learner_domain_logins_username_lower
    check (username = lower(username)),
  constraint learner_domain_logins_username_domain
    check (username like '%@' || domain),
  constraint learner_domain_logins_user_domain_uq unique (user_id, domain),
  constraint learner_domain_logins_username_uq unique (username)
);

-- RLS on, no policies: only the owner (hol_app) reads or writes.
alter table hol_app.learner_domain_logins enable row level security;
