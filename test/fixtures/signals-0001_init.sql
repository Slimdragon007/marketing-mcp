-- One row per sync attempt per source. Every data row points back at the run that wrote it.
CREATE TABLE sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK (source IN ('ga4', 'ig', 'fb')),
  trigger TEXT NOT NULL CHECK (trigger IN ('cron', 'admin')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'error')),
  window_start TEXT,
  window_end TEXT,
  rows_written INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX sync_runs_source_started ON sync_runs (source, started_at);

CREATE TABLE ga4_daily (
  date TEXT PRIMARY KEY,
  sessions INTEGER NOT NULL,
  total_users INTEGER NOT NULL,
  new_users INTEGER NOT NULL,
  screen_page_views INTEGER NOT NULL,
  engaged_sessions INTEGER NOT NULL,
  user_engagement_seconds REAL NOT NULL,
  key_events REAL NOT NULL,
  run_id INTEGER NOT NULL REFERENCES sync_runs (id),
  synced_at TEXT NOT NULL
);

CREATE TABLE ga4_daily_dims (
  date TEXT NOT NULL,
  dimension TEXT NOT NULL,
  value TEXT NOT NULL,
  sessions INTEGER NOT NULL,
  total_users INTEGER NOT NULL,
  screen_page_views INTEGER NOT NULL,
  run_id INTEGER NOT NULL REFERENCES sync_runs (id),
  synced_at TEXT NOT NULL,
  PRIMARY KEY (date, dimension, value)
);

-- Long format: one row per (day, platform, metric). Absent rows mean Meta returned no data.
CREATE TABLE meta_daily (
  date TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ig', 'fb')),
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  run_id INTEGER NOT NULL REFERENCES sync_runs (id),
  synced_at TEXT NOT NULL,
  PRIMARY KEY (date, platform, metric)
);

-- Lifetime metrics per post, overwritten on each refresh.
CREATE TABLE ig_posts (
  media_id TEXT PRIMARY KEY,
  posted_at TEXT NOT NULL,
  media_type TEXT,
  media_product_type TEXT,
  permalink TEXT,
  caption TEXT,
  reach INTEGER,
  views INTEGER,
  likes INTEGER,
  comments INTEGER,
  saved INTEGER,
  shares INTEGER,
  total_interactions INTEGER,
  run_id INTEGER NOT NULL REFERENCES sync_runs (id),
  synced_at TEXT NOT NULL
);
CREATE INDEX ig_posts_posted_at ON ig_posts (posted_at);

-- Never holds rows. A publish batch inserts 0 here when a newer overlapping run
-- has already published; the CHECK fails and the whole batch rolls back.
CREATE TABLE publish_guard (ok INTEGER NOT NULL CHECK (ok = 1));
