CREATE TABLE admission_rotations (
  repository_id TEXT PRIMARY KEY REFERENCES repositories(id), fingerprint TEXT NOT NULL,
  weights_version INTEGER NOT NULL, weights TEXT NOT NULL CHECK(json_valid(weights)), cursor TEXT CHECK(cursor IS NULL OR json_valid(cursor))
);
CREATE TABLE admission_reservations (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), repository_id TEXT NOT NULL REFERENCES repositories(id),
  status TEXT NOT NULL CHECK(status IN ('pending', 'confirmed', 'released')), lease_active INTEGER NOT NULL CHECK(lease_active IN (0, 1)),
  fence INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload))
);
CREATE UNIQUE INDEX one_active_repository_lease ON admission_reservations(repository_id) WHERE lease_active = 1;
CREATE UNIQUE INDEX one_active_task_lease ON admission_reservations(task_id) WHERE lease_active = 1;
CREATE TABLE admission_fences (repository_id TEXT PRIMARY KEY REFERENCES repositories(id), fence INTEGER NOT NULL);
CREATE TABLE admission_clock (id INTEGER PRIMARY KEY CHECK(id = 1), high_water_day TEXT NOT NULL);
CREATE TABLE admission_starts (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, reservation_id TEXT NOT NULL UNIQUE REFERENCES admission_reservations(id),
  repository_id TEXT NOT NULL REFERENCES repositories(id), recipe_id TEXT NOT NULL REFERENCES recipes(id), day_key TEXT NOT NULL
);
CREATE INDEX admission_starts_day ON admission_starts(day_key);
CREATE TABLE admission_attention (id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload)));
CREATE TABLE recipe_readiness (
  recipe_id TEXT NOT NULL, recipe_revision TEXT NOT NULL, recipe_hash TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(recipe_id, recipe_revision, recipe_hash),
  FOREIGN KEY(recipe_id, recipe_revision) REFERENCES recipe_revisions(recipe_id, revision)
);
