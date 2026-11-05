CREATE TABLE lifecycle_state (
  attempt_id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload))
);
CREATE TABLE lifecycle_actions (
  action_id TEXT PRIMARY KEY REFERENCES outbox(id), attempt_id TEXT NOT NULL, fence INTEGER NOT NULL
);
-- Existing live writers have no comparable monotonic segment. Never reset their duration budget.
INSERT INTO lifecycle_state(attempt_id, payload)
SELECT json_extract(payload, '$.attempt.id'), json_object('segments', json('[]'), 'active', json_object('epoch', 'pre-lifecycle-migration', 'started', 0), 'quiescent', json('false'))
FROM admission_reservations WHERE status = 'confirmed' AND lease_active = 1;
