-- 0020: where Policy has got to in the event outbox when it reads Billing's requests. Owned by Policy.
CREATE TABLE policy.consumer_offset (
  consumer       text   PRIMARY KEY,
  last_event_id  bigint NOT NULL
);
