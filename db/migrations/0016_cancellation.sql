-- 0016: cancellation and reinstatement (document section 8). Owned by Policy.
-- A cancellation is a new policy version in which the cover ends on the effective date (cancelled_on). Its refund is
-- worked out when the job starts and kept as a cover_adjustment. A reinstatement brings the cover back, with or
-- without a gap. Their money moves are premium transactions of the new kinds.

ALTER TABLE policy.policy_period ADD COLUMN cancelled_on date;

ALTER TABLE policy.premium_transaction DROP CONSTRAINT premium_transaction_kind_check;
ALTER TABLE policy.premium_transaction ADD CONSTRAINT premium_transaction_kind_check
  CHECK (kind IN ('new_business', 'change', 'cancellation', 'reinstatement'));

CREATE TABLE policy.cover_adjustment (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                  uuid        NOT NULL UNIQUE REFERENCES policy.job (id),
  branch_id               uuid        NOT NULL UNIQUE REFERENCES policy.policy_period (id),
  kind                    text        NOT NULL CHECK (kind IN ('cancellation', 'reinstatement')),
  reason_code             text,                       -- a cancellation_reason typelist code
  source                  text        CHECK (source IN ('insured', 'insurer')),
  method                  text        CHECK (method IN ('flat', 'pro_rata', 'short_rate')),
  effective_date          date        NOT NULL,       -- the first day without cover (cancellation) / the cancellation date (reinstatement)
  restore_date            date,                       -- reinstatement with a gap: the first day covered again
  term_premium_paise      bigint,
  term_tax_paise          bigint,
  refund_premium_paise    bigint,
  refund_tax_paise        bigint,
  retained_premium_paise  bigint,
  days_in_force           integer,
  unexpired_days          integer,
  term_days               integer,
  worksheet               jsonb       NOT NULL DEFAULT '[]',
  created_by              text        NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'cancellation' OR (reason_code IS NOT NULL AND method IS NOT NULL AND refund_premium_paise IS NOT NULL))
);

CREATE FUNCTION policy.guard_cover_adjustment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A cover adjustment cannot be changed or deleted';
END;
$$;

CREATE TRIGGER cover_adjustment_guard BEFORE UPDATE OR DELETE ON policy.cover_adjustment
  FOR EACH ROW EXECUTE FUNCTION policy.guard_cover_adjustment();
