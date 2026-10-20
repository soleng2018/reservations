-- Spec 0016 AC-15: the Audit Log pages by (created_at, id), so the paging
-- index carries the tie breaker and every page is exact. It replaces the
-- created_at only index, which nothing else reads. No column, table,
-- constraint, or trigger changes. Index names are a contract with
-- server/db/constraint-errors.ts.

create index audit_events_created_at_id_idx
  on hol_app.audit_events (created_at desc, id desc);
drop index hol_app.audit_events_created_at_idx;
