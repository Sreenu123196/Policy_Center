-- 0006: the audit log (document sections 5, 13 and 19). Owned by Platform.
-- Every change is recorded: who made it (a person or an agent), when, what it was, and what it touched.
-- The log is append-only. The triggers below make the database itself refuse to change or remove an entry.
CREATE TABLE platform.audit_log (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  actor        text        NOT NULL,          -- the user name of the person or agent
  action       text        NOT NULL,          -- for example account.create
  entity_type  text        NOT NULL,          -- for example account
  entity_id    text        NOT NULL,
  reason       text,                          -- why, when the person gave a reason
  details      jsonb       NOT NULL DEFAULT '{}'  -- never personal numbers such as Aadhaar or PAN
);

CREATE INDEX audit_log_entity ON platform.audit_log (entity_type, entity_id);

CREATE FUNCTION platform.audit_log_is_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'The audit log is append-only';
END;
$$;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON platform.audit_log
  FOR EACH ROW EXECUTE FUNCTION platform.audit_log_is_append_only();
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON platform.audit_log
  FOR EACH ROW EXECUTE FUNCTION platform.audit_log_is_append_only();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON platform.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION platform.audit_log_is_append_only();
