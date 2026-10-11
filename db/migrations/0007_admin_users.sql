-- Spec 0008 AC-15: admin users (feature 10). Index names are a contract with
-- server/db/constraint-errors.ts; renaming one is a breaking change.

-- A learner's bookings, newest first: the user detail table and the users
-- list's per learner count. `if not exists`: the shared database already
-- had this exact index, created by hand before this migration.
create index if not exists bookings_user_id_starts_at_idx
  on hol_app.bookings (user_id, starts_at desc);
