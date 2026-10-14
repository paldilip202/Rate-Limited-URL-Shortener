CREATE TABLE IF NOT EXISTS urls (
  id          BIGSERIAL PRIMARY KEY,
  code        VARCHAR(12) NOT NULL,
  long_url    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ,
  click_count BIGINT NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_urls_code ON urls (code);