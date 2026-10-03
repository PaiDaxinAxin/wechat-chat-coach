// Only the deployment administrator runs this initializer. Runtime store creation
// never creates or changes database objects. Nothing outside chat_coach is changed.
export const POSTGRES_SCHEMA_VERSION = 1;
export const POSTGRES_SCHEMA_SQL = String.raw`
CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL, normalized_username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, plan TEXT NOT NULL CHECK(plan IN ('free','paid')),
      role TEXT NOT NULL CHECK(role IN ('user','owner')), classification_used INTEGER NOT NULL DEFAULT 0,
      classification_reserved INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invites (
      token_hash TEXT PRIMARY KEY, plan TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL, expires_at BIGINT NOT NULL, used_by TEXT REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL, expires_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mcp_tokens (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      issued_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, expires_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS profiles (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS counterparts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      value_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, id TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      counterpart_id TEXT NOT NULL REFERENCES counterparts(id) ON DELETE CASCADE,
      speaker TEXT NOT NULL, text TEXT NOT NULL, suggestion_id TEXT,
      provenance TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS suggestions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      counterpart_id TEXT NOT NULL REFERENCES counterparts(id) ON DELETE CASCADE,
      value_json TEXT NOT NULL, context_hash TEXT NOT NULL, knowledge_hash TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meetings (
      counterpart_id TEXT PRIMARY KEY REFERENCES counterparts(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, value_json TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS provider_budget (
      subject TEXT NOT NULL, day TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, reserved INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(subject,day)
    );
    CREATE TABLE IF NOT EXISTS reply_daily_usage (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, day TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0 CHECK(used >= 0), reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved >= 0),
      PRIMARY KEY(user_id,day)
    );
    CREATE TABLE IF NOT EXISTS model_jobs (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      counterpart_id TEXT NOT NULL REFERENCES counterparts(id) ON DELETE CASCADE,
      operation TEXT NOT NULL, request_id TEXT NOT NULL, context_hash TEXT NOT NULL, knowledge_hash TEXT NOT NULL,
      state TEXT NOT NULL, result_json TEXT, error_code TEXT, classification_reservation INTEGER NOT NULL DEFAULT 0,
      provider_reservation INTEGER NOT NULL DEFAULT 0, budget_day TEXT NOT NULL,
      worker_id TEXT NOT NULL, provider_model TEXT NOT NULL, cache_of TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(user_id,operation,request_id),
      _ordinal BIGINT GENERATED ALWAYS AS IDENTITY
    );
    CREATE INDEX IF NOT EXISTS model_cache ON model_jobs(user_id,counterpart_id,operation,context_hash,state);
    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      counterpart_id TEXT NOT NULL REFERENCES counterparts(id) ON DELETE CASCADE,
      stage TEXT NOT NULL, raw_json TEXT NOT NULL, cleaning_json TEXT, review_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS feedback_reviews (
      id TEXT PRIMARY KEY, feedback_id TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
      reviewer_id TEXT NOT NULL REFERENCES users(id), value_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS knowledge_approvals (
      feedback_id TEXT PRIMARY KEY REFERENCES feedback(id) ON DELETE CASCADE,
      review_hash TEXT NOT NULL, marker TEXT NOT NULL, supplement TEXT NOT NULL, review_json TEXT NOT NULL,
      state TEXT NOT NULL, knowledge_hash TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY, actor_id TEXT REFERENCES users(id), action TEXT NOT NULL, entity_id TEXT,
      details_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS followup_receipts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      counterpart_id TEXT NOT NULL REFERENCES counterparts(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(user_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS reply_copy_receipts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      counterpart_id TEXT NOT NULL REFERENCES counterparts(id) ON DELETE CASCADE,
      suggestion_id TEXT NOT NULL REFERENCES suggestions(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, copied_text TEXT NOT NULL, copied_at TEXT NOT NULL,
      UNIQUE(user_id,request_id),
      _ordinal BIGINT GENERATED ALWAYS AS IDENTITY
    );
    CREATE TABLE IF NOT EXISTS style_reviews (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      counterpart_id TEXT NOT NULL REFERENCES counterparts(id) ON DELETE CASCADE,
      value_json TEXT NOT NULL, created_at TEXT NOT NULL,
      _ordinal BIGINT GENERATED ALWAYS AS IDENTITY
    );
    CREATE TABLE IF NOT EXISTS style_rules (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      value_json TEXT NOT NULL, status TEXT NOT NULL,
      source_review_id TEXT REFERENCES style_reviews(id) ON DELETE SET NULL,
      supersedes_id TEXT REFERENCES style_rules(id), rule_hash TEXT NOT NULL,
      created_at TEXT NOT NULL, adopted_at TEXT, revoked_at TEXT,
      _ordinal BIGINT GENERATED ALWAYS AS IDENTITY
    );
    CREATE TABLE IF NOT EXISTS style_save_receipts (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, request_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL, result_ids_json TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(user_id,request_id)
    );
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_interval_json TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS wechat_time_json TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_message_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS annotation_json TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS annotation_updated_at TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS annotation_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reply_copy_receipts ADD COLUMN IF NOT EXISTS annotation_revisions_json TEXT;
ALTER TABLE model_jobs ADD COLUMN IF NOT EXISTS context_snapshot_json TEXT;
ALTER TABLE model_jobs ADD COLUMN IF NOT EXISTS snapshot_hash TEXT;
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS origin_job_id TEXT REFERENCES model_jobs(id) ON DELETE CASCADE;
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS _ordinal BIGINT GENERATED ALWAYS AS IDENTITY;
ALTER TABLE followup_receipts ADD COLUMN IF NOT EXISTS previous_suggestion_id TEXT;
ALTER TABLE followup_receipts ADD COLUMN IF NOT EXISTS previous_reply_hash TEXT;
ALTER TABLE followup_receipts ADD COLUMN IF NOT EXISTS counterpart_text_hash TEXT;
ALTER TABLE followup_receipts ADD COLUMN IF NOT EXISTS copy_receipt_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS style_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS active_style_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE model_jobs ADD COLUMN IF NOT EXISTS lease_expires_at BIGINT;
ALTER TABLE model_jobs ADD COLUMN IF NOT EXISTS reply_reservation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE model_jobs ADD COLUMN IF NOT EXISTS reply_day TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS model_pending_context ON model_jobs(user_id,counterpart_id,operation,context_hash) WHERE state IN ('reserved','running');
CREATE INDEX IF NOT EXISTS model_expired_lease ON model_jobs(lease_expires_at) WHERE state IN ('reserved','running');
CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,reset_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS rate_limit_expiry ON rate_limits(reset_at);
CREATE TABLE IF NOT EXISTS schema_version(singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),version INTEGER NOT NULL);
INSERT INTO schema_version(singleton,version) VALUES(TRUE,1) ON CONFLICT(singleton) DO NOTHING;
CREATE OR REPLACE FUNCTION protect_case_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.context_snapshot_json IS DISTINCT FROM NEW.context_snapshot_json OR OLD.snapshot_hash IS DISTINCT FROM NEW.snapshot_hash THEN
    RAISE EXCEPTION 'IMMUTABLE_CASE_SNAPSHOT';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS model_snapshot_immutable ON model_jobs;
CREATE TRIGGER model_snapshot_immutable BEFORE UPDATE OF context_snapshot_json,snapshot_hash ON model_jobs FOR EACH ROW EXECUTE FUNCTION protect_case_snapshot();
CREATE OR REPLACE FUNCTION protect_style_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.value_json IS DISTINCT FROM NEW.value_json THEN RAISE EXCEPTION 'IMMUTABLE_STYLE_REVIEW'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS style_review_immutable ON style_reviews;
CREATE TRIGGER style_review_immutable BEFORE UPDATE OF value_json ON style_reviews FOR EACH ROW EXECUTE FUNCTION protect_style_review();
CREATE OR REPLACE FUNCTION protect_style_rule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.value_json IS DISTINCT FROM NEW.value_json OR OLD.rule_hash IS DISTINCT FROM NEW.rule_hash OR OLD.supersedes_id IS DISTINCT FROM NEW.supersedes_id THEN
    RAISE EXCEPTION 'IMMUTABLE_STYLE_RULE';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS style_rule_body_immutable ON style_rules;
CREATE TRIGGER style_rule_body_immutable BEFORE UPDATE OF value_json,rule_hash,supersedes_id ON style_rules FOR EACH ROW EXECUTE FUNCTION protect_style_rule();
REVOKE ALL ON SCHEMA chat_coach FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA chat_coach FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA chat_coach FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA chat_coach FROM PUBLIC;
DO $$
DECLARE tab RECORD; browser_role TEXT;
BEGIN
  FOR tab IN SELECT tablename FROM pg_tables WHERE schemaname='chat_coach' LOOP
    EXECUTE format('ALTER TABLE chat_coach.%I ENABLE ROW LEVEL SECURITY', tab.tablename);
  END LOOP;
  FOREACH browser_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=browser_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA chat_coach FROM %I', browser_role);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA chat_coach FROM %I', browser_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA chat_coach FROM %I', browser_role);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA chat_coach FROM %I', browser_role);
    END IF;
  END LOOP;
END $$;
`;

export async function initializePostgresSchema(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(1784961896, 0)');
    await client.query('CREATE SCHEMA IF NOT EXISTS chat_coach');
    await client.query('SET LOCAL search_path TO chat_coach, pg_catalog');
    await client.query(POSTGRES_SCHEMA_SQL);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

/** The administrator creates this login separately with a private password.
 * Its privileges stay within this project's schema; no public/Data API grant is added.
 */
export async function grantPostgresRuntimeAccess(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(1784961896, 0)');
    await client.query(`
      REVOKE ALL ON SCHEMA chat_coach FROM chat_coach_app;
      REVOKE ALL ON ALL TABLES IN SCHEMA chat_coach FROM chat_coach_app;
      REVOKE ALL ON ALL SEQUENCES IN SCHEMA chat_coach FROM chat_coach_app;
      REVOKE ALL ON ALL FUNCTIONS IN SCHEMA chat_coach FROM chat_coach_app;
      GRANT USAGE ON SCHEMA chat_coach TO chat_coach_app;
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA chat_coach TO chat_coach_app;
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA chat_coach TO chat_coach_app;
      DO $$
      DECLARE tab RECORD;
      BEGIN
        FOR tab IN SELECT tablename FROM pg_tables WHERE schemaname='chat_coach' LOOP
          EXECUTE format('ALTER TABLE chat_coach.%I ENABLE ROW LEVEL SECURITY', tab.tablename);
          EXECUTE format('DROP POLICY IF EXISTS chat_coach_server ON chat_coach.%I', tab.tablename);
          EXECUTE format('CREATE POLICY chat_coach_server ON chat_coach.%I TO chat_coach_app USING (TRUE) WITH CHECK (TRUE)', tab.tablename);
        END LOOP;
      END $$;
    `);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}
