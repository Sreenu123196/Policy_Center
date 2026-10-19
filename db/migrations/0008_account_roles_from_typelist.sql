-- 0008: account contact roles now come from the account_contact_role typelist (document section 18).
-- Migration 0004 hard-coded the four roles in the database. A new role should be a configuration release,
-- not a code and database change, so that fixed list is dropped; the code now checks the typelist instead.
-- The rule "exactly one named insured per account" stays: it is a business rule, not configuration.
ALTER TABLE policy.account_contact DROP CONSTRAINT account_contact_role_check;
