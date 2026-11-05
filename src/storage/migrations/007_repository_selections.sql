CREATE TABLE repository_selections (
  repository_id TEXT PRIMARY KEY REFERENCES repositories(id),
  payload TEXT NOT NULL CHECK(json_valid(payload))
);
CREATE TABLE repository_selection_receipts (
  request_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL CHECK(json_valid(payload))
);
