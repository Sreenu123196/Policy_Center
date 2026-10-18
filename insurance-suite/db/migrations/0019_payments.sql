-- 0019: payments, allocation, payouts and missed-payment steps (document section 14). Owned by Billing.
-- Money in is a payment; it is allocated to invoice lines (oldest first). Money that cannot be allocated stays as
-- unapplied cash, and money that cannot be matched to an account waits in suspense (a payment with no billing account).

ALTER TABLE billing.invoice_line ADD COLUMN paid_paise bigint NOT NULL DEFAULT 0;
ALTER TABLE billing.invoice_line ADD CONSTRAINT invoice_line_paid_within CHECK (paid_paise >= 0 AND paid_paise <= amount_paise);

CREATE TABLE billing.payment (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  seq                 bigint      GENERATED ALWAYS AS IDENTITY,
  billing_account_id  uuid        REFERENCES billing.account (id),       -- null while the payment is in suspense
  policy_number       text,                                              -- the payer said which policy this is for
  amount_paise        bigint      NOT NULL CHECK (amount_paise > 0),
  method              text        NOT NULL CHECK (method IN ('upi', 'enach', 'card', 'bank_transfer')),
  reference           text        NOT NULL UNIQUE,                       -- the same reference twice is the same payment
  received_on         date        NOT NULL,
  note                text,
  created_by          text        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Where each rupee went: from a payment or a credit to an invoice line. Never changed.
CREATE TABLE billing.allocation (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  seq              bigint      GENERATED ALWAYS AS IDENTITY,
  payment_id       uuid        REFERENCES billing.payment (id),
  credit_id        uuid        REFERENCES billing.credit (id),
  invoice_line_id  uuid        NOT NULL REFERENCES billing.invoice_line (id),
  amount_paise     bigint      NOT NULL CHECK (amount_paise > 0),
  created_by       text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((payment_id IS NULL) <> (credit_id IS NULL))
);
CREATE INDEX allocation_payment ON billing.allocation (payment_id);
CREATE INDEX allocation_credit ON billing.allocation (credit_id);

CREATE FUNCTION billing.guard_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'An allocation cannot be changed or deleted';
END;
$$;
CREATE TRIGGER allocation_guard BEFORE UPDATE OR DELETE ON billing.allocation
  FOR EACH ROW EXECUTE FUNCTION billing.guard_allocation();

-- Money paid out to the customer from a credit.
CREATE TABLE billing.payout (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_id     uuid        NOT NULL REFERENCES billing.credit (id),
  amount_paise  bigint      NOT NULL CHECK (amount_paise > 0),
  method        text        NOT NULL CHECK (method IN ('upi', 'enach', 'card', 'bank_transfer')),
  reference     text        NOT NULL UNIQUE,
  paid_on       date        NOT NULL,
  created_by    text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- The timed steps taken for a late invoice. One of each action per invoice: a step is never done twice.
CREATE TABLE billing.delinquency_step (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  seq         bigint      GENERATED ALWAYS AS IDENTITY,
  invoice_id  uuid        NOT NULL REFERENCES billing.invoice (id),
  action      text        NOT NULL CHECK (action IN ('reminder', 'final_notice', 'cancellation_request', 'reinstatement_requested')),
  done_on     date        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, action)
);
