-- 0001: the database foundation (document sections 2 and 6).
-- One schema per module. A module reads and writes only its own schema.
CREATE SCHEMA IF NOT EXISTS contacts;
CREATE SCHEMA IF NOT EXISTS policy;
CREATE SCHEMA IF NOT EXISTS billing;
CREATE SCHEMA IF NOT EXISTS claims;
CREATE SCHEMA IF NOT EXISTS platform;

-- Needed for the rule that slices of one object never overlap in time (Appendix A).
CREATE EXTENSION IF NOT EXISTS btree_gist;
