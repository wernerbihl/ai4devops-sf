CREATE TABLE broker_capabilities (id TEXT PRIMARY KEY, payload TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE broker_writes (attempt_id TEXT NOT NULL, fence INTEGER NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','unknown','done')), result TEXT, PRIMARY KEY(attempt_id, fence));
CREATE TABLE broker_results (attempt_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE broker_artifacts (id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, payload TEXT NOT NULL);
