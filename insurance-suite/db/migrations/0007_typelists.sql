-- 0007: versioned configuration and typelists (document section 18). Owned by Platform.
-- A typelist is a managed list of codes with a name in each language (English, Hindi, Telugu).
-- Codes are never deleted or reused: an old code is "retired", because old records still refer to it.

-- Which version of each configuration file has been loaded, when, by whom, and from what date it applies.
CREATE TABLE platform.config_version (
  kind            text        NOT NULL,                  -- the sort of configuration; 'typelist' for now
  name            text        NOT NULL,                  -- for example account_contact_role
  version         text        NOT NULL CHECK (version ~ '^[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,3}$'),
  checksum        text        NOT NULL,                  -- fingerprint of the file, to spot a changed file
  effective_from  date        NOT NULL,
  loaded_by       text        NOT NULL,
  loaded_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, name, version)
);

CREATE TABLE platform.typelist (
  name  text PRIMARY KEY CHECK (name ~ '^[a-z][a-z0-9_]{2,40}$')
);

CREATE TABLE platform.typelist_entry (
  typelist    text    NOT NULL REFERENCES platform.typelist (name),
  code        text    NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{0,39}$'),
  sort_order  integer NOT NULL CHECK (sort_order >= 0),
  retired     boolean NOT NULL DEFAULT false,
  -- All three names are required, so a code can never be shown without a name in some language.
  name_en     text    NOT NULL CHECK (btrim(name_en) <> ''),
  name_hi     text    NOT NULL CHECK (btrim(name_hi) <> ''),
  name_te     text    NOT NULL CHECK (btrim(name_te) <> ''),
  PRIMARY KEY (typelist, code)
);
