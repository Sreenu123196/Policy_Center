-- 0004: accounts and their contacts (document section 5). Owned by Policy.
-- An account is the customer relationship. Names and addresses live in the Contacts module.
-- Other modules' ids (contacts, producer codes) are stored WITHOUT a foreign key: modules never read
-- each other's tables, so the code checks them through the other module's public API instead.

-- The sequence gives every account its own number, so two accounts can never share one.
CREATE SEQUENCE policy.account_number_seq;

CREATE TABLE policy.account (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_number  text        NOT NULL UNIQUE
                  DEFAULT 'AC-' || lpad(nextval('policy.account_number_seq')::text, 7, '0'),
  status          text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  producer_code   text        NOT NULL,   -- the producer of record; decides who may see this account
  created_by      text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE policy.account_contact (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid        NOT NULL REFERENCES policy.account (id),
  contact_id  uuid        NOT NULL,       -- a record in the Contacts module
  role        text        NOT NULL CHECK (role IN ('named_insured', 'driver', 'financier', 'billing_contact')),
  created_by  text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, contact_id, role)
);

-- Every account has exactly one named insured: the database allows at most one.
CREATE UNIQUE INDEX account_one_named_insured ON policy.account_contact (account_id) WHERE role = 'named_insured';
