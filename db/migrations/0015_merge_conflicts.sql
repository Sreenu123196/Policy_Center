-- 0015: merge conflicts (document section 6, Appendix B). Owned by Policy.
-- When a change takes effect earlier than a change that is already bound, and the later change set the same field, the
-- later change wins by default. The conflict is recorded so a person can confirm it ("keep_later") or override it.

CREATE TABLE policy.merge_conflict (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  seq           bigint      GENERATED ALWAYS AS IDENTITY,
  branch_id     uuid        NOT NULL REFERENCES policy.policy_period (id),
  object_kind   text        NOT NULL CHECK (object_kind IN ('coverage', 'coverable')),
  fixed_id      uuid        NOT NULL,                 -- the object both changes touched
  field         text        NOT NULL,                 -- for example idv
  edit_date     date        NOT NULL,                 -- where the new edit starts
  later_version integer     NOT NULL,                 -- the bound version that already set the field
  later_date    date        NOT NULL,                 -- from when that version set it
  our_value     jsonb       NOT NULL,                 -- what the new edit wanted
  later_value   jsonb       NOT NULL,                 -- what the later change set; it wins until resolved
  resolution    text        CHECK (resolution IN ('keep_later', 'override')),
  resolved_by   text,
  reason        text,
  resolved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((resolution IS NULL) = (resolved_by IS NULL))
);
CREATE INDEX merge_conflict_branch ON policy.merge_conflict (branch_id, seq);
