-- 0011: quotes and quote options (document section 8). Owned by Policy.
-- A job can hold several branches (quote options). Each is a working copy with a label; pricing a branch stores a
-- quote, which is a permanent record: the price, its tax, until when it is valid and the worksheet that explains it.

ALTER TABLE policy.policy_period ADD COLUMN label text NOT NULL DEFAULT 'Option A';

CREATE TABLE policy.quote (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  seq             bigint      GENERATED ALWAYS AS IDENTITY,       -- the order quotes were made in
  branch_id       uuid        NOT NULL REFERENCES policy.policy_period (id),
  premium_paise   bigint      NOT NULL CHECK (premium_paise >= 0),
  tax_paise       bigint      NOT NULL CHECK (tax_paise >= 0),
  total_paise     bigint      NOT NULL CHECK (total_paise = premium_paise + tax_paise),
  currency        text        NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  valid_until     date        NOT NULL,
  rate_book       text        NOT NULL,                           -- which rates produced the price
  worksheet       jsonb       NOT NULL DEFAULT '[]',              -- the steps of the calculation
  created_by      text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quote_branch ON policy.quote (branch_id, seq);

CREATE FUNCTION policy.guard_quote() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A quote cannot be changed or deleted; make a new quote instead';
END;
$$;

CREATE TRIGGER quote_guard BEFORE UPDATE OR DELETE ON policy.quote
  FOR EACH ROW EXECUTE FUNCTION policy.guard_quote();
