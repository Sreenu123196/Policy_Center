-- 0018: billing (document section 14). Owned by Billing.
-- Billing learns about policies only through events. It stores the policy account id and policy number it was told,
-- with NO foreign key into the Policy schema (modules never read each other's tables).

CREATE SEQUENCE billing.invoice_number_seq;

CREATE TABLE billing.account (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid        NOT NULL UNIQUE,                  -- the account in Policy this bills; usually one billing account per account
  plan_code   text        NOT NULL,                         -- a payment plan from config/billing
  status      text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Where each consumer has got to in the event outbox: the id of the last event it handled.
CREATE TABLE billing.consumer_offset (
  consumer       text   PRIMARY KEY,
  last_event_id  bigint NOT NULL
);

-- What Policy told us to charge, one row for the premium and one for the tax. Negative amounts are refunds.
CREATE TABLE billing.charge (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_account_id  uuid        NOT NULL REFERENCES billing.account (id),
  source_event_id     bigint      NOT NULL,                 -- the outbox event; an event is never charged twice
  policy_id           uuid        NOT NULL,
  policy_number       text        NOT NULL,
  term_number         integer     NOT NULL,
  version             integer     NOT NULL,
  kind                text        NOT NULL CHECK (kind IN ('new_business', 'change', 'cancellation', 'reinstatement', 'renewal')),
  type                text        NOT NULL CHECK (type IN ('premium', 'tax')),
  effective_date      date        NOT NULL,
  amount_paise        bigint      NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_event_id, type)
);

-- A payment the customer will be asked for: the charge split by the payment plan. It becomes part of an invoice.
CREATE TABLE billing.schedule_item (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_account_id  uuid        NOT NULL REFERENCES billing.account (id),
  source_event_id     bigint      NOT NULL,
  policy_number       text        NOT NULL,
  kind                text        NOT NULL,
  sequence            integer     NOT NULL CHECK (sequence >= 1),   -- 1 is the down payment
  due_date            date        NOT NULL,
  premium_paise       bigint      NOT NULL CHECK (premium_paise >= 0),
  tax_paise           bigint      NOT NULL CHECK (tax_paise >= 0),
  fee_paise           bigint      NOT NULL CHECK (fee_paise >= 0),
  amount_paise        bigint      NOT NULL CHECK (amount_paise = premium_paise + tax_paise + fee_paise),
  status              text        NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'invoiced', 'paid', 'void')),
  invoice_id          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_event_id, sequence)
);
CREATE INDEX schedule_item_due ON billing.schedule_item (due_date) WHERE status = 'scheduled';

-- Return premium from a cancellation or a change: money owed to the customer, to be paid out or applied (step F2).
CREATE TABLE billing.credit (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_account_id  uuid        NOT NULL REFERENCES billing.account (id),
  source_event_id     bigint      NOT NULL UNIQUE,
  policy_number       text        NOT NULL,
  kind                text        NOT NULL,
  effective_date      date        NOT NULL,
  premium_paise       bigint      NOT NULL CHECK (premium_paise >= 0),
  tax_paise           bigint      NOT NULL CHECK (tax_paise >= 0),
  total_paise         bigint      NOT NULL CHECK (total_paise = premium_paise + tax_paise),
  status              text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'refunded', 'applied')),
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- A tax invoice: made by a batch some days before the due date. Items of one billing account due on the same day
-- made in the same batch go into one invoice.
CREATE TABLE billing.invoice (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  number              text        NOT NULL UNIQUE DEFAULT 'INV-' || lpad(nextval('billing.invoice_number_seq')::text, 7, '0'),
  billing_account_id  uuid        NOT NULL REFERENCES billing.account (id),
  invoice_date        date        NOT NULL,
  due_date            date        NOT NULL,
  premium_paise       bigint      NOT NULL,
  tax_paise           bigint      NOT NULL,
  fee_paise           bigint      NOT NULL,
  total_paise         bigint      NOT NULL CHECK (total_paise = premium_paise + tax_paise + fee_paise),
  status              text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'void')),
  created_by          text        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE billing.invoice_line (
  id                uuid   PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id        uuid   NOT NULL REFERENCES billing.invoice (id),
  schedule_item_id  uuid   NOT NULL UNIQUE REFERENCES billing.schedule_item (id),
  policy_number     text   NOT NULL,
  description       text   NOT NULL,
  premium_paise     bigint NOT NULL,
  tax_paise         bigint NOT NULL,
  fee_paise         bigint NOT NULL,
  amount_paise      bigint NOT NULL CHECK (amount_paise = premium_paise + tax_paise + fee_paise)
);
