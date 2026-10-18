-- 0021: claims and first notice of loss (document section 15). Owned by Claims.
-- Claims knows the policy only by its number and by the snapshot Policy gave for the loss date; it holds NO foreign key
-- into the Policy schema.

CREATE SEQUENCE claims.claim_number_seq;

CREATE TABLE claims.claim (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_number         text        NOT NULL UNIQUE DEFAULT 'CL-' || lpad(nextval('claims.claim_number_seq')::text, 7, '0'),
  policy_number        text        NOT NULL,
  policy_id            uuid        NOT NULL,
  account_id           uuid        NOT NULL,
  loss_date            date        NOT NULL,
  loss_time            text        CHECK (loss_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  reported_on          date        NOT NULL,
  cause                text        NOT NULL,                 -- a loss_cause typelist code
  place                text        NOT NULL,
  description          text        NOT NULL,
  channel              text        NOT NULL CHECK (channel IN ('staff', 'portal', 'phone', 'whatsapp', 'partner')),
  reporter_name        text,
  reporter_phone       text,
  status               text        NOT NULL DEFAULT 'submitted'
                       CHECK (status IN ('submitted', 'under_review', 'documents_pending', 'approved', 'settled', 'rejected', 'closed')),
  verification_status  text        NOT NULL CHECK (verification_status IN ('verified', 'not_verified')),
  verification         jsonb       NOT NULL,                 -- reasons, duplicates, and the policy as it was on the loss date
  late_report          boolean     NOT NULL,
  created_by           text        NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (reported_on >= loss_date)
);
CREATE INDEX claim_policy ON claims.claim (policy_number);

-- Incidents describe damage or injury. Exposures (a claimant against a cover) come in step G2.
CREATE TABLE claims.incident (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  seq          bigint      GENERATED ALWAYS AS IDENTITY,
  claim_id     uuid        NOT NULL REFERENCES claims.claim (id),
  kind         text        NOT NULL CHECK (kind IN ('damage', 'injury')),
  description  text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- A reference to a photo or document kept elsewhere (the file store is an adapter, document section 17).
CREATE TABLE claims.attachment (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  seq         bigint      GENERATED ALWAYS AS IDENTITY,
  claim_id    uuid        NOT NULL REFERENCES claims.claim (id),
  reference   text        NOT NULL,
  caption     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
