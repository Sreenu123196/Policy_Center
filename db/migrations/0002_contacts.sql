-- 0002: the Contacts module (document section 16).
-- One row per person or company, shared by Policy, Billing and Claims through its id.
-- The formats are checked here again, so a bug in the code cannot save bad data.
CREATE TABLE contacts.contact (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text        NOT NULL CHECK (kind IN ('person', 'company')),
  name            text        NOT NULL,          -- a person's full name, or a company's legal name
  date_of_birth   date,                          -- people only
  phone           text,                          -- one standard form: +91 and ten digits
  email           text,
  address_line1   text        NOT NULL,
  address_line2   text,
  city            text        NOT NULL,
  state           text        NOT NULL,
  pin_code        text        NOT NULL CHECK (pin_code ~ '^[1-9][0-9]{5}$'),
  pan             text        CHECK (pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  gstin           text        CHECK (gstin ~ '^(0[1-9]|[12][0-9]|3[0-8])[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  -- Aadhaar is never stored in full: only this masked form is allowed.
  aadhaar_masked  text        CHECK (aadhaar_masked ~ '^XXXX XXXX [0-9]{4}$'),
  created_by      text        NOT NULL,          -- the person or agent who made the record
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'person' OR (date_of_birth IS NULL AND aadhaar_masked IS NULL)),
  CHECK (kind = 'company' OR gstin IS NULL)
);
