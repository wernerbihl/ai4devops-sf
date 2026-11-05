CREATE TABLE broker_revocations (attempt_id TEXT PRIMARY KEY, revoked_at TEXT NOT NULL);
-- v5 revokeAttempt only changed token rows. Preserve that irreversible intent during upgrade.
INSERT INTO broker_revocations(attempt_id, revoked_at)
SELECT DISTINCT json_extract(payload, '$.scope.attemptId'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM broker_capabilities WHERE revoked = 1;
