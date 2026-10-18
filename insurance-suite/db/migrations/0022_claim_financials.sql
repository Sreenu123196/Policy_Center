-- 0022: exposures, reserves, payments and recoveries (document section 15). Owned by Claims.
-- Money is whole paise. Reserve history, payments and recoveries are records that are never changed.

CREATE TABLE claims.exposure (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id         uuid        NOT NULL REFERENCES claims.claim (id),
  number           integer     NOT NULL CHECK (number >= 1),          -- 1, 2 ... within the claim
  coverage_code    text        NOT NULL,                              -- the cover of the policy this claim is made against
  claimant_name    text        NOT NULL CHECK (btrim(claimant_name) <> ''),
  claimant_kind    text        NOT NULL CHECK (claimant_kind IN ('insured', 'third_party')),
  description      text        NOT NULL,
  status           text        NOT NULL DEFAULT 'submitted'
                   CHECK (status IN ('submitted', 'under_review', 'documents_pending', 'approved', 'settled', 'rejected', 'closed')),
  handler          text,
  limit_paise      bigint,                                            -- the most that can be paid for this cover (own damage: the insured value)
  deductible_paise bigint      NOT NULL DEFAULT 0,
  created_by       text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (claim_id, number)
);

-- The outstanding reserve of one line (cost type and category) of an exposure.
CREATE TABLE claims.reserve_line (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  exposure_id       uuid        NOT NULL REFERENCES claims.exposure (id),
  cost_type         text        NOT NULL CHECK (cost_type IN ('claim_cost', 'expense')),
  category          text        NOT NULL,
  outstanding_paise bigint      NOT NULL CHECK (outstanding_paise >= 0),
  UNIQUE (exposure_id, cost_type, category)
);

-- Every change of a reserve line: set by a person, reduced by a payment, or released by a final payment.
CREATE TABLE claims.reserve_change (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  seq          bigint      GENERATED ALWAYS AS IDENTITY,
  exposure_id  uuid        NOT NULL REFERENCES claims.exposure (id),
  cost_type    text        NOT NULL,
  category     text        NOT NULL,
  old_paise    bigint      NOT NULL,
  new_paise    bigint      NOT NULL,
  reason       text,
  changed_by   text        NOT NULL,
  changed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE claims.claim_payment (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  seq              bigint      GENERATED ALWAYS AS IDENTITY,
  exposure_id      uuid        NOT NULL REFERENCES claims.exposure (id),
  cost_type        text        NOT NULL CHECK (cost_type IN ('claim_cost', 'expense')),
  category         text        NOT NULL,
  amount_paise     bigint      NOT NULL CHECK (amount_paise > 0),
  kind             text        NOT NULL CHECK (kind IN ('partial', 'final')),
  payee_kind       text        NOT NULL CHECK (payee_kind IN ('claimant', 'garage', 'hospital', 'other')),
  payee_name       text        NOT NULL,
  instrument       text        NOT NULL,                              -- masked: only the last digits of an account, part of a UPI address
  method           text        NOT NULL CHECK (method IN ('bank_transfer', 'upi')),
  reference        text        NOT NULL UNIQUE,
  note             text,
  paid_on          date        NOT NULL,
  status           text        NOT NULL CHECK (status IN ('issued', 'pending_approval')),
  requested_by     text        NOT NULL,
  approved_by      text,
  approval_reason  text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE claims.recovery (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  seq           bigint      GENERATED ALWAYS AS IDENTITY,
  exposure_id   uuid        NOT NULL REFERENCES claims.exposure (id),
  kind          text        NOT NULL CHECK (kind IN ('subrogation', 'salvage', 'deductible')),
  amount_paise  bigint      NOT NULL CHECK (amount_paise > 0),
  source        text        NOT NULL,
  reference     text        NOT NULL UNIQUE,
  received_on   date        NOT NULL,
  created_by    text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION claims.guard_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A reserve change or a recovery cannot be changed or deleted';
END;
$$;
CREATE TRIGGER reserve_change_guard BEFORE UPDATE OR DELETE ON claims.reserve_change FOR EACH ROW EXECUTE FUNCTION claims.guard_history();
CREATE TRIGGER recovery_guard BEFORE UPDATE OR DELETE ON claims.recovery FOR EACH ROW EXECUTE FUNCTION claims.guard_history();
