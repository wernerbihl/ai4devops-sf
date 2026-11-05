CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL CHECK(json_valid(payload)));
CREATE TABLE tags (id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload)));
CREATE TABLE repositories (id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload)));
CREATE TABLE repository_weights (
  repository_id TEXT NOT NULL REFERENCES repositories(id), tag_id TEXT NOT NULL REFERENCES tags(id),
  value INTEGER NOT NULL CHECK(value BETWEEN 0 AND 100), PRIMARY KEY(repository_id, tag_id)
);
CREATE TABLE recipes (
  id TEXT PRIMARY KEY, tag_id TEXT NOT NULL REFERENCES tags(id), current_revision TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  FOREIGN KEY(id, current_revision) REFERENCES recipe_revisions(recipe_id, revision) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE recipe_revisions (
  id TEXT PRIMARY KEY, recipe_id TEXT NOT NULL REFERENCES recipes(id) DEFERRABLE INITIALLY DEFERRED,
  revision TEXT NOT NULL, tag_id TEXT NOT NULL REFERENCES tags(id), payload TEXT NOT NULL CHECK(json_valid(payload)),
  UNIQUE(recipe_id, revision)
);
CREATE TRIGGER immutable_recipe_update BEFORE UPDATE ON recipe_revisions BEGIN SELECT RAISE(ABORT, 'immutable recipe revision'); END;
CREATE TRIGGER immutable_recipe_delete BEFORE DELETE ON recipe_revisions BEGIN SELECT RAISE(ABORT, 'immutable recipe revision'); END;
CREATE TABLE task_nodes (id TEXT PRIMARY KEY);
CREATE TABLE submissions (
  id TEXT PRIMARY KEY REFERENCES task_nodes(id), created_at TEXT NOT NULL, recipe_id TEXT NOT NULL REFERENCES recipes(id),
  request TEXT NOT NULL CHECK(json_valid(request))
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY REFERENCES task_nodes(id), repository_id TEXT NOT NULL REFERENCES repositories(id),
  recipe_id TEXT NOT NULL, recipe_revision TEXT NOT NULL, tag_id TEXT NOT NULL REFERENCES tags(id),
  parent_id TEXT REFERENCES task_nodes(id), creator_attempt_id TEXT REFERENCES actor_scopes(attempt_id),
  revision INTEGER NOT NULL CHECK(revision > 0), payload TEXT NOT NULL CHECK(json_valid(payload)),
  FOREIGN KEY(recipe_id, recipe_revision) REFERENCES recipe_revisions(recipe_id, revision)
);
CREATE TABLE submission_children (
  submission_id TEXT NOT NULL REFERENCES submissions(id), task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
  repository_id TEXT NOT NULL REFERENCES repositories(id), PRIMARY KEY(submission_id, repository_id)
);
CREATE TABLE task_revisions (
  task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL CHECK(revision > 0),
  payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(task_id, revision)
);
CREATE TRIGGER immutable_task_update BEFORE UPDATE ON task_revisions BEGIN SELECT RAISE(ABORT, 'immutable task revision'); END;
CREATE TRIGGER immutable_task_delete BEFORE DELETE ON task_revisions BEGIN SELECT RAISE(ABORT, 'immutable task revision'); END;
CREATE TABLE grants (
  id TEXT PRIMARY KEY, recipe_id TEXT NOT NULL, recipe_revision TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  FOREIGN KEY(recipe_id, recipe_revision) REFERENCES recipe_revisions(recipe_id, revision)
);
CREATE TABLE actor_scopes (
  attempt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), recipe_id TEXT NOT NULL,
  recipe_revision TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
  FOREIGN KEY(recipe_id, recipe_revision) REFERENCES recipe_revisions(recipe_id, revision)
);
CREATE TABLE findings (
  repository_id TEXT NOT NULL REFERENCES repositories(id), recipe_id TEXT NOT NULL REFERENCES recipes(id),
  finding_key TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY(repository_id, recipe_id, finding_key)
);
CREATE TABLE idempotency (
  namespace TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL,
  result TEXT NOT NULL CHECK(json_valid(result)), PRIMARY KEY(namespace, key)
);
CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL CHECK(json_valid(payload))
);
CREATE TABLE outbox (
  id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
  created_at TEXT NOT NULL, completed_at TEXT
);
CREATE INDEX tasks_repo ON tasks(repository_id);
CREATE INDEX tasks_recipe ON tasks(recipe_id, recipe_revision);
CREATE INDEX outbox_pending ON outbox(created_at) WHERE completed_at IS NULL;
