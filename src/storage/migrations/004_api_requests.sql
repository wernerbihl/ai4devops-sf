CREATE TABLE api_requests (
  key TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'complete')),
  result TEXT CHECK(result IS NULL OR json_valid(result))
);
