-- 0024: event consumers with retries and a dead-letter list (document section 17). Owned by Platform.
-- A consumer (Billing, Policy) keeps its place in the outbox here. This replaces the two offset tables the modules
-- kept for themselves; the places they had reached are copied over first.

CREATE TABLE platform.event_consumer (
  consumer       text   PRIMARY KEY,
  last_event_id  bigint NOT NULL
);
INSERT INTO platform.event_consumer (consumer, last_event_id) SELECT consumer, last_event_id FROM billing.consumer_offset;
INSERT INTO platform.event_consumer (consumer, last_event_id) SELECT consumer, last_event_id FROM policy.consumer_offset
  ON CONFLICT (consumer) DO NOTHING;
DROP TABLE billing.consumer_offset;
DROP TABLE policy.consumer_offset;

-- An event a consumer could not handle. 'retrying' waits until next_attempt_at; 'dead' has been given up on and
-- waits for a person; 'resolved' was handled later (a retry that worked, or a redrive).
CREATE TABLE platform.event_failure (
  consumer         text        NOT NULL,
  event_id         bigint      NOT NULL REFERENCES platform.outbox (id),
  attempts         integer     NOT NULL CHECK (attempts > 0),
  last_error       text        NOT NULL,
  status           text        NOT NULL CHECK (status IN ('retrying', 'dead', 'resolved')),
  first_failed_at  timestamptz NOT NULL,
  last_failed_at   timestamptz NOT NULL,
  next_attempt_at  timestamptz,
  resolved_by      text,
  resolved_at      timestamptz,
  PRIMARY KEY (consumer, event_id)
);
CREATE INDEX event_failure_dead ON platform.event_failure (consumer, event_id) WHERE status = 'dead';
