-- 0012: underwriting issues, decisions and referrals (document section 10). Owned by Policy.
-- A rule raises an issue on a branch. An underwriter decides it; every decision is kept as history.
-- "Request approval" puts a referral (a task for the underwriter queue) with the full context.

CREATE TABLE policy.uw_issue (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id   uuid        NOT NULL REFERENCES policy.policy_period (id),
  rule_code   text        NOT NULL,
  issue_type  text        NOT NULL,
  blocks      text        NOT NULL CHECK (blocks IN ('quote', 'bind', 'issuance', 'none')),
  compare     text        NOT NULL CHECK (compare IN ('max', 'min')),
  value       bigint      NOT NULL,                  -- the number that caused the issue: paise, or years
  message     text        NOT NULL,
  status      text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'referred', 'approved', 'rejected', 'cleared')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, rule_code)                      -- one issue per rule per branch; it is reopened, not repeated
);

-- Decisions are history: never changed or deleted.
CREATE TABLE policy.uw_decision (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  seq          bigint      GENERATED ALWAYS AS IDENTITY,
  issue_id     uuid        NOT NULL REFERENCES policy.uw_issue (id),
  decision     text        NOT NULL CHECK (decision IN ('approved', 'approved_with_conditions', 'rejected')),
  decided_by   text        NOT NULL,
  reason       text        NOT NULL CHECK (btrim(reason) <> ''),
  limit_value  bigint,                               -- the approval covers values up to (max) or down to (min) this
  valid_until  date,                                 -- the last day the approval counts
  conditions   text,
  decided_at   timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION policy.guard_uw_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'An underwriting decision cannot be changed or deleted';
END;
$$;

CREATE TRIGGER uw_decision_guard BEFORE UPDATE OR DELETE ON policy.uw_decision
  FOR EACH ROW EXECUTE FUNCTION policy.guard_uw_decision();

CREATE TABLE policy.uw_referral (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  seq           bigint      GENERATED ALWAYS AS IDENTITY,
  issue_id      uuid        NOT NULL REFERENCES policy.uw_issue (id),
  requested_by  text        NOT NULL,
  note          text,
  status        text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  context       jsonb       NOT NULL,                -- small facts for the underwriter: policy, job, issue type, value
  created_at    timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz
);
CREATE INDEX uw_referral_open ON policy.uw_referral (status, seq);
