-- 0014: policy change and premium transactions (document sections 5, 6 and 9). Owned by Policy.
-- A policy change job has an effective date: the day the change starts. A premium transaction records what a bound
-- version changed in premium compared with the version it was based on; billing (step F1) receives transactions.

ALTER TABLE policy.job ADD COLUMN effective_date date;

CREATE TABLE policy.premium_transaction (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  seq             bigint      GENERATED ALWAYS AS IDENTITY,
  policy_id       uuid        NOT NULL REFERENCES policy.policy (id),
  branch_id       uuid        NOT NULL UNIQUE REFERENCES policy.policy_period (id),   -- one transaction per bound version
  based_on_id     uuid        REFERENCES policy.policy_period (id),
  version         integer     NOT NULL CHECK (version >= 1),
  kind            text        NOT NULL CHECK (kind IN ('new_business', 'change')),
  effective_date  date        NOT NULL,
  premium_paise   bigint      NOT NULL,          -- signed: a refund is negative
  tax_paise       bigint      NOT NULL,
  total_paise     bigint      NOT NULL CHECK (total_paise = premium_paise + tax_paise),
  created_by      text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX premium_transaction_policy ON policy.premium_transaction (policy_id, seq);

CREATE FUNCTION policy.guard_premium_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A premium transaction cannot be changed or deleted';
END;
$$;

CREATE TRIGGER premium_transaction_guard BEFORE UPDATE OR DELETE ON policy.premium_transaction
  FOR EACH ROW EXECUTE FUNCTION policy.guard_premium_transaction();
