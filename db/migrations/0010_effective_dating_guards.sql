-- 0010: guards on effective-dated rows and bound versions (document sections 5 and 6).
-- Two rules are enforced by the database itself, so even a bug in our code cannot break them:
--   1. A bound version is never edited: no insert, update or delete of its rows, and the period cannot change.
--   2. An effective-dated row lies inside the policy period of its branch.

CREATE FUNCTION policy.guard_effective_dated_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  branch_status text;
  starts date;
  ends date;
BEGIN
  -- Changing or removing a row of a bound version is refused.
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT status INTO branch_status FROM policy.policy_period WHERE id = OLD.branch_id;
    IF branch_status = 'bound' THEN
      RAISE EXCEPTION 'A bound policy version cannot be changed';
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT status, period_start, period_end INTO branch_status, starts, ends FROM policy.policy_period WHERE id = NEW.branch_id;
    IF branch_status = 'bound' THEN
      RAISE EXCEPTION 'A bound policy version cannot be changed';
    END IF;
    IF NEW.eff_from < starts OR NEW.eff_to > ends THEN
      RAISE EXCEPTION 'An effective-dated row must lie inside the policy period (% to %)', starts, ends;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER coverable_guard BEFORE INSERT OR UPDATE OR DELETE ON policy.coverable
  FOR EACH ROW EXECUTE FUNCTION policy.guard_effective_dated_row();
CREATE TRIGGER coverage_guard BEFORE INSERT OR UPDATE OR DELETE ON policy.coverage
  FOR EACH ROW EXECUTE FUNCTION policy.guard_effective_dated_row();

-- A bound policy period (a version) can never be updated or deleted. Binding itself is an update of a branch that is
-- not bound yet, so it is allowed.
CREATE FUNCTION policy.guard_bound_period() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'bound' THEN
    RAISE EXCEPTION 'A bound policy version cannot be changed';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER policy_period_guard BEFORE UPDATE OR DELETE ON policy.policy_period
  FOR EACH ROW EXECUTE FUNCTION policy.guard_bound_period();
