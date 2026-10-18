-- 0013: the event outbox (Platform) and stored documents (Policy). Document sections 11 and 17.
-- An event is written in the same transaction as the change it reports, then published later, in order.
-- Consumers (billing, step F1) read unpublished events and must cope with seeing one twice.

CREATE TABLE platform.outbox (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type            text        NOT NULL CHECK (type ~ '^[A-Z][A-Za-z0-9]{2,59}$'),     -- for example PolicyBound
  aggregate_type  text        NOT NULL,                                               -- for example policy
  aggregate_id    uuid        NOT NULL,                                               -- events of one aggregate stay in order
  payload         jsonb       NOT NULL,                                               -- small facts only, no personal numbers
  created_at      timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz
);
CREATE INDEX outbox_unpublished ON platform.outbox (id) WHERE published_at IS NULL;

-- A document produced for a policy, for example the policy schedule. Stored with metadata and a checksum;
-- never changed afterwards. A corrected document is a new one.
CREATE TABLE policy.document (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  seq           bigint      GENERATED ALWAYS AS IDENTITY,
  policy_id     uuid        NOT NULL REFERENCES policy.policy (id),
  job_id        uuid        NOT NULL REFERENCES policy.job (id),
  branch_id     uuid        NOT NULL REFERENCES policy.policy_period (id),
  kind          text        NOT NULL,
  content_type  text        NOT NULL,
  content       bytea       NOT NULL,
  sha256        text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  metadata      jsonb       NOT NULL DEFAULT '{}',        -- policy number, job number, version, form codes
  created_by    text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_policy ON policy.document (policy_id, seq);

CREATE FUNCTION policy.guard_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A document cannot be changed or deleted; make a new one instead';
END;
$$;

CREATE TRIGGER document_guard BEFORE UPDATE OR DELETE ON policy.document
  FOR EACH ROW EXECUTE FUNCTION policy.guard_document();
