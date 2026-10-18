-- 0009: policies, jobs, branches and effective-dated rows (document sections 4, 5 and 6, Appendix A). Owned by Policy.
-- A policy is the contract. A job is a unit of work on it. A branch (a "policy period" row) is a working copy of one
-- term inside a job; once bound it is a numbered, never-edited version.

CREATE SEQUENCE policy.policy_number_seq;
CREATE SEQUENCE policy.job_number_seq;

CREATE TABLE policy.policy (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The number is given once and never changes.
  policy_number  text        NOT NULL UNIQUE DEFAULT 'PL-' || lpad(nextval('policy.policy_number_seq')::text, 7, '0'),
  account_id     uuid        NOT NULL REFERENCES policy.account (id),
  product_code   text        NOT NULL,        -- a product in the catalogue; configuration lives in files, so no foreign key
  created_by     text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE policy.job (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_number  text        NOT NULL UNIQUE DEFAULT 'J-' || lpad(nextval('policy.job_number_seq')::text, 7, '0'),
  policy_id   uuid        NOT NULL REFERENCES policy.policy (id),
  type        text        NOT NULL CHECK (type IN
                ('submission', 'issuance', 'policy_change', 'cancellation', 'reinstatement', 'renewal', 'rewrite', 'audit')),
  status      text        NOT NULL DEFAULT 'draft' CHECK (status IN
                ('draft', 'quoted', 'binding', 'bound', 'issued', 'withdrawn', 'declined', 'not_taken', 'preempted')),
  created_by  text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE policy.policy_period (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id        uuid        NOT NULL REFERENCES policy.policy (id),
  job_id           uuid        NOT NULL REFERENCES policy.job (id),
  term_number      integer     NOT NULL CHECK (term_number >= 1),
  version          integer     CHECK (version >= 1),                 -- given when the branch is bound
  based_on_id      uuid        REFERENCES policy.policy_period (id), -- the version this branch was copied from
  status           text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'quoted', 'bound', 'withdrawn')),
  period_start     date        NOT NULL,
  period_end       date        NOT NULL,                             -- exclusive: the first day NOT covered
  product_version  text        NOT NULL,                             -- the product version in force on the start date
  created_by       text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (period_start < period_end),
  -- A version number if and only if the branch is bound.
  CHECK ((status = 'bound') = (version IS NOT NULL)),
  UNIQUE (policy_id, term_number, version)
);

-- Effective-dated rows. fixed_id is the same for every slice and every version of one object; row_id is per slice.
-- The EXCLUDE rule makes overlapping slices of one object impossible (Appendix A). The end date is excluded,
-- so one slice may end on the day the next begins.
CREATE TABLE policy.coverable (
  row_id      bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  branch_id   uuid        NOT NULL REFERENCES policy.policy_period (id),
  fixed_id    uuid        NOT NULL,
  kind        text        NOT NULL CHECK (kind IN ('Vehicle', 'Driver', 'Location', 'Building')),
  eff_from    date        NOT NULL,
  eff_to      date        NOT NULL,
  attributes  jsonb       NOT NULL DEFAULT '{}',
  created_by  text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (eff_from < eff_to),
  EXCLUDE USING gist (branch_id WITH =, fixed_id WITH =, daterange(eff_from, eff_to) WITH &&)
);

CREATE TABLE policy.coverage (
  row_id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  branch_id      uuid        NOT NULL REFERENCES policy.policy_period (id),
  fixed_id       uuid        NOT NULL,
  coverable_fid  uuid        NOT NULL,        -- the fixed id of the vehicle, driver ... this cover belongs to
  pattern_code   text        NOT NULL CHECK (pattern_code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  eff_from       date        NOT NULL,
  eff_to         date        NOT NULL,
  terms          jsonb       NOT NULL DEFAULT '{}',    -- for example {"idv": 50000000, "vol_deductible": 0}; money in paise
  created_by     text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (eff_from < eff_to),
  EXCLUDE USING gist (branch_id WITH =, fixed_id WITH =, daterange(eff_from, eff_to) WITH &&)
);

CREATE INDEX coverable_branch ON policy.coverable (branch_id);
CREATE INDEX coverage_branch ON policy.coverage (branch_id);
