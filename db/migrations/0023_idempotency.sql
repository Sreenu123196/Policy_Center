-- 0023: idempotency keys for the API (document section 17: "Every POST takes an idempotency key"). Owned by Platform.
-- A client that repeats a request with the same key gets the same answer, and nothing is done twice.

CREATE TABLE platform.idempotency_key (
  user_name     text        NOT NULL,
  key           text        NOT NULL,
  request_hash  text        NOT NULL,        -- the method, path and body of the first request
  status_code   integer     NOT NULL,
  response      jsonb       NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_name, key)
);
