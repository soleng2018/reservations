-- Spec 0020: a live booking holds its testbed for 30 minutes after ends_at,
-- so the cleanup automation has time between two labs. The constraint keeps
-- its name (a contract with mapConstraintError). The 30 minutes is GAP_MS in
-- lib/slots.ts; a database test keeps the two equal to the millisecond.

set local lock_timeout = '5s';

-- No booking can land while this migration counts and rebuilds.
lock table hol_app.bookings in share row exclusive mode;

-- Stop, and keep the old constraint, when a live pair already sits inside a
-- gap. The same predicate as the constraint, with no ends_at > now() filter,
-- because an ended booking not yet swept is still live.
do $$
declare
  pairs bigint;
begin
  select count(*) into pairs
  from hol_app.bookings a
  join hol_app.bookings b
    on a.testbed_id = b.testbed_id
   and a.id < b.id
  where a.status in ('provisioning', 'confirmed')
    and b.status in ('provisioning', 'confirmed')
    and tstzrange(a.starts_at, a.ends_at + interval '30 minutes', '[)')
     && tstzrange(b.starts_at, b.ends_at + interval '30 minutes', '[)');
  if pairs > 0 then
    raise exception
      'migration 0016 stopped: % live booking pair(s) sit inside a 30 minute gap; move or cancel one booking of each pair, then run it again',
      pairs;
  end if;
end
$$;

alter table hol_app.bookings drop constraint bookings_no_overlap;

-- timestamptz + interval is not immutable, so the padded end is computed on
-- a UTC timestamp. A fixed 30 minutes has no daylight saving effect.
alter table hol_app.bookings add constraint bookings_no_overlap exclude using gist (
  testbed_id with =,
  tstzrange(
    starts_at,
    ((ends_at at time zone 'UTC') + interval '30 minutes') at time zone 'UTC',
    '[)'
  ) with &&
) where (status in ('provisioning', 'confirmed'));
