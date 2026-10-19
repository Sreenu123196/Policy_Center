-- 0017: renewal (document section 8). Owned by Policy.
-- A renewal creates the next term (term_number + 1) of the same policy. Its premium is a transaction of the new kind
-- 'renewal'. Before renewal, the insurer gives a direction (renew, non_renew, review); a non-renewal needs a second
-- person's approval and a notice document sent in time.

ALTER TABLE policy.premium_transaction DROP CONSTRAINT premium_transaction_kind_check;
ALTER TABLE policy.premium_transaction ADD CONSTRAINT premium_transaction_kind_check
  CHECK (kind IN ('new_business', 'change', 'cancellation', 'reinstatement', 'renewal'));

CREATE TABLE policy.renewal_direction (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  seq                 bigint      GENERATED ALWAYS AS IDENTITY,
  policy_id           uuid        NOT NULL REFERENCES policy.policy (id),
  term_number         integer     NOT NULL CHECK (term_number >= 1),        -- the term that is about to expire
  direction           text        NOT NULL CHECK (direction IN ('renew', 'non_renew', 'review')),
  reason              text        NOT NULL CHECK (btrim(reason) <> ''),
  set_by              text        NOT NULL,
  approved_by         text,                                                  -- non-renewal only: the second person
  approval_reason     text,
  approved_at         timestamptz,
  notice_document_id  uuid        REFERENCES policy.document (id),            -- the non-renewal notice, once sent
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((approved_by IS NULL) = (approval_reason IS NULL))
);
CREATE INDEX renewal_direction_policy ON policy.renewal_direction (policy_id, term_number, seq);
