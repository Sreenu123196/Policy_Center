-- 0003: producer organisations and producer codes (document sections 5 and 13). Owned by Platform.
-- A producer is an agent or broker. A producer code decides what that agent may see, and later the commission.
CREATE TABLE platform.producer_organisation (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL CHECK (btrim(name) <> ''),
  created_by  text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Two organisations may not differ only by capital letters.
CREATE UNIQUE INDEX producer_organisation_name_key ON platform.producer_organisation (lower(name));

CREATE TABLE platform.producer_code (
  code             text        PRIMARY KEY CHECK (code ~ '^[A-Z0-9-]{3,20}$'),
  organisation_id  uuid        NOT NULL REFERENCES platform.producer_organisation (id),
  status           text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by       text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
