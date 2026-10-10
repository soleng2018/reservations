-- Better Auth tables (spec 0003), generated once from better-auth 1.7.7's own
-- schema (`getMigrations` from better-auth/db/migration, plugins: genericOAuth)
-- and committed. Columns are Better Auth's; only the schema qualifier, the
-- explicit constraint names, and RLS were added. Regenerate and diff when
-- upgrading Better Auth.

create table hol_auth."user" (
  "id" text not null primary key,
  "name" text not null,
  "email" text not null,
  "emailVerified" boolean not null,
  "image" text,
  "createdAt" timestamptz default current_timestamp not null,
  "updatedAt" timestamptz default current_timestamp not null,
  constraint user_email_uq unique ("email")
);

create table hol_auth."session" (
  "id" text not null primary key,
  "expiresAt" timestamptz not null,
  "token" text not null,
  "createdAt" timestamptz default current_timestamp not null,
  "updatedAt" timestamptz not null,
  "ipAddress" text,
  "userAgent" text,
  "userId" text not null,
  constraint session_token_uq unique ("token"),
  constraint session_user_id_fkey foreign key ("userId")
    references hol_auth."user" ("id") on delete cascade
);
create index session_user_id_idx on hol_auth."session" ("userId");

create table hol_auth."account" (
  "id" text not null primary key,
  "accountId" text not null,
  "providerId" text not null,
  "userId" text not null,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope" text,
  "password" text,
  "createdAt" timestamptz default current_timestamp not null,
  "updatedAt" timestamptz not null,
  constraint account_user_id_fkey foreign key ("userId")
    references hol_auth."user" ("id") on delete cascade
);
create index account_user_id_idx on hol_auth."account" ("userId");

create table hol_auth."verification" (
  "id" text not null primary key,
  "identifier" text not null,
  "value" text not null,
  "expiresAt" timestamptz not null,
  "createdAt" timestamptz default current_timestamp not null,
  "updatedAt" timestamptz default current_timestamp not null
);
create index verification_identifier_idx on hol_auth."verification" ("identifier");

alter table hol_auth."user" enable row level security;
alter table hol_auth."session" enable row level security;
alter table hol_auth."account" enable row level security;
alter table hol_auth."verification" enable row level security;

-- The one link between the app and Better Auth (spec 0002).
alter table hol_app.users
  add column auth_user_id text,
  add constraint users_auth_user_id_uq unique (auth_user_id),
  add constraint users_auth_user_id_fkey foreign key (auth_user_id)
    references hol_auth."user" (id) on delete set null;

-- True while a saga created Authentik user has not signed in yet; gates resend.
alter table hol_app.users
  add column set_password_pending boolean not null default false;
