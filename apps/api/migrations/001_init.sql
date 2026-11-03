-- Гараж бортів і історія тюнів.
-- owner_id поки що випадковий UUID клієнта; після появи акаунтів стане посиланням на users.

CREATE TABLE IF NOT EXISTS builds (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    text        NOT NULL,
  name        text        NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  params      jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS builds_owner_updated_idx ON builds (owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS tune_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  build_id    uuid        NOT NULL REFERENCES builds (id) ON DELETE CASCADE,
  kind        text        NOT NULL CHECK (kind IN ('start', 'log')),
  payload     jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tune_sessions_build_created_idx ON tune_sessions (build_id, created_at DESC);
