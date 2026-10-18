-- 0005: users, roles and permissions (document section 13). Owned by Platform.
-- A user is a person or an AI agent. A role is a named bundle of permissions. Roles are data, so an
-- administrator can change them without a code release. The list of permissions the system knows is in
-- the code (src/platform/permissions.ts); the database only checks their shape.
CREATE TABLE platform.app_user (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text        NOT NULL CHECK (username ~ '^[a-z][a-z0-9.]{2,29}$'),
  display_name  text        NOT NULL CHECK (btrim(display_name) <> ''),
  kind          text        NOT NULL DEFAULT 'person' CHECK (kind IN ('person', 'agent')),
  status        text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by    text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX app_user_username_key ON platform.app_user (username);

CREATE TABLE platform.role (
  code        text        PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{2,29}$'),
  name        text        NOT NULL CHECK (btrim(name) <> ''),
  created_by  text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform.role_permission (
  role_code   text NOT NULL REFERENCES platform.role (code),
  permission  text NOT NULL CHECK (permission ~ '^[a-z_]+\.[a-z_]+$'),
  PRIMARY KEY (role_code, permission)
);

CREATE TABLE platform.user_role (
  user_id     uuid        NOT NULL REFERENCES platform.app_user (id),
  role_code   text        NOT NULL REFERENCES platform.role (code),
  created_by  text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_code)
);

-- The producer codes a user holds decide which accounts they may see (section 13).
CREATE TABLE platform.user_producer_code (
  user_id        uuid        NOT NULL REFERENCES platform.app_user (id),
  producer_code  text        NOT NULL REFERENCES platform.producer_code (code),
  created_by     text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, producer_code)
);
