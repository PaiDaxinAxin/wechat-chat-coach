import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { PROJECT_ROOT } from './knowledge.mjs';
import { appliedPersonalStyle, MAX_ACTIVE_STYLE_RULES, STYLE_REVIEW_VERSION, StyleLearningInputSchema } from './style-learning.mjs';

const derive = promisify(scrypt);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const json = (value) => JSON.stringify(value);
const parse = (value) => value ? JSON.parse(value) : null;

import { BetaError, safeUser } from './store-contract.mjs';
export { BetaError, safeUser };

function credentials(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') throw new BetaError('CREDENTIALS_INVALID');
  const normalized = username.normalize('NFC').trim();
  if (normalized.length < 2 || normalized.length > 40 || !/^[\p{L}\p{N}_.-]+$/u.test(normalized)) throw new BetaError('USERNAME_INVALID');
  if (password.length < 10 || password.length > 128 || !/\p{L}/u.test(password) || !/\p{N}/u.test(password)) throw new BetaError('PASSWORD_INVALID');
  return { username: normalized, normalized: normalized.toLocaleLowerCase('en-US'), password };
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt:v1:${salt}:${key.toString('hex')}`;
}

async function passwordMatches(password, encoded) {
  try {
    const parts = encoded?.split(':');
    const salt = parts?.[2] ?? '00000000000000000000000000000000';
    const expected = Buffer.from(parts?.[3] ?? '00'.repeat(64), 'hex');
    const actual = await derive(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return expected.length === actual.length && timingSafeEqual(expected, actual) && parts?.[0] === 'scrypt';
  } catch { return false; }
}

export function createBetaStore({
  dataDir = join(PROJECT_ROOT, 'data/beta'),
  freeProviderDailyLimit = 10, paidProviderDailyLimit = 10, globalProviderDailyLimit = 100,
  now = Date.now,
} = {}) {
  for (const limit of [freeProviderDailyLimit, paidProviderDailyLimit, globalProviderDailyLimit]) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new BetaError('BUDGET_CONFIGURATION_INVALID');
  }
  const directory = resolve(dataDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, 'beta.sqlite'));
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL, normalized_username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, plan TEXT NOT NULL CHECK(plan IN ('free','paid')),
      role TEXT NOT NULL CHECK(role IN ('user','owner')), classification_used INTEGER NOT NULL DEFAULT 0,
      classification_reserved INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invites (
      token_hash TEXT PRIMARY KEY, plan TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL, expires_at INTEGER NOT NULL, used_by TEXT REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mcp_tokens (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      issued_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS profiles (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS counterparts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      value_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
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
      UNIQUE(user_id,operation,request_id)
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
      UNIQUE(user_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS style_reviews (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      counterpart_id TEXT NOT NULL REFERENCES counterparts(id) ON DELETE CASCADE,
      value_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS style_rules (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      value_json TEXT NOT NULL, status TEXT NOT NULL,
      source_review_id TEXT REFERENCES style_reviews(id) ON DELETE SET NULL,
      supersedes_id TEXT REFERENCES style_rules(id), rule_hash TEXT NOT NULL,
      created_at TEXT NOT NULL, adopted_at TEXT, revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS style_save_receipts (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, request_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL, result_ids_json TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(user_id,request_id)
    );`);
  const addColumn = (table, name, declaration) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
  };
  addColumn('messages', 'reply_interval_json', 'TEXT');
  addColumn('messages', 'wechat_time_json', 'TEXT');
  addColumn('messages', 'reply_to_message_id', 'TEXT');
  addColumn('messages', 'annotation_json', 'TEXT');
  addColumn('messages', 'annotation_updated_at', 'TEXT');
  addColumn('messages', 'annotation_revision', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('reply_copy_receipts', 'annotation_revisions_json', 'TEXT');
  addColumn('model_jobs', 'context_snapshot_json', 'TEXT');
  addColumn('model_jobs', 'snapshot_hash', 'TEXT');
  addColumn('model_jobs', 'reply_reservation', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('model_jobs', 'reply_day', 'TEXT');
  addColumn('suggestions', 'origin_job_id', 'TEXT REFERENCES model_jobs(id) ON DELETE CASCADE');
  addColumn('followup_receipts', 'previous_suggestion_id', 'TEXT');
  addColumn('followup_receipts', 'previous_reply_hash', 'TEXT');
  addColumn('followup_receipts', 'counterpart_text_hash', 'TEXT');
  addColumn('followup_receipts', 'copy_receipt_id', 'TEXT');
  addColumn('users', 'style_revision', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('users', 'active_style_revision', 'INTEGER NOT NULL DEFAULT 0');
  db.exec(`CREATE TRIGGER IF NOT EXISTS model_snapshot_immutable BEFORE UPDATE OF context_snapshot_json,snapshot_hash ON model_jobs
    WHEN OLD.context_snapshot_json IS NOT NEW.context_snapshot_json OR OLD.snapshot_hash IS NOT NEW.snapshot_hash
    BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_CASE_SNAPSHOT'); END;`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS style_review_immutable BEFORE UPDATE OF value_json ON style_reviews
    WHEN OLD.value_json IS NOT NEW.value_json BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_STYLE_REVIEW'); END;
    CREATE TRIGGER IF NOT EXISTS style_rule_body_immutable BEFORE UPDATE OF value_json,rule_hash,supersedes_id ON style_rules
    WHEN OLD.value_json IS NOT NEW.value_json OR OLD.rule_hash IS NOT NEW.rule_hash OR OLD.supersedes_id IS NOT NEW.supersedes_id
    BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_STYLE_RULE'); END;`);
  const get = (sql, ...arguments_) => db.prepare(sql).get(...arguments_);
  const all = (sql, ...arguments_) => db.prepare(sql).all(...arguments_);
  const run = (sql, ...arguments_) => db.prepare(sql).run(...arguments_);
  const timestamp = () => new Date(now()).toISOString();
  const day = () => timestamp().slice(0, 10);
  const replyDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now()));
  const transaction = (callback) => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const audit = (actorId, action, entityId, details = {}) => run('INSERT INTO audit_log VALUES(?,?,?,?,?,?)', randomUUID(), actorId, action, entityId, json(details), timestamp());
  const user = (id) => { const row = get('SELECT * FROM users WHERE id=?', id); if (!row) throw new BetaError('ACCOUNT_NOT_FOUND', 404); return row; };
  const owner = (id) => { const row = user(id); if (row.role !== 'owner') throw new BetaError('OWNER_REQUIRED', 403); return row; };
  const counterpartRow = (userId, id) => { const row = get('SELECT * FROM counterparts WHERE id=? AND user_id=?', id, userId); if (!row) throw new BetaError('COUNTERPART_NOT_FOUND', 404); return row; };
  const counterpartValue = (row) => ({ ...parse(row.value_json), id: row.id, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at });
  const messageValue = (row) => {
    if (!row) return null;
    const wechatTime = parse(row.wechat_time_json);
    let replyInterval = parse(row.reply_interval_json);
    if (row.reply_to_message_id) {
      const previous = get('SELECT speaker,wechat_time_json FROM messages WHERE id=? AND user_id=? AND counterpart_id=?', row.reply_to_message_id, row.user_id, row.counterpart_id);
      const sentTime = parse(previous?.wechat_time_json);
      if (row.speaker !== 'other' || previous?.speaker !== 'self') replyInterval = null;
      else if (wechatTime && sentTime) {
        const delta = Date.parse(wechatTime.at) - Date.parse(sentTime.at);
        const valid = Number.isSafeInteger(delta) && delta >= 0;
        replyInterval = { fromAt: sentTime.at, toAt: wechatTime.at, elapsedMs: valid ? delta : null, fromSource: 'user_reported_wechat_sent', toSource: 'user_reported_wechat_received', reliability: valid ? 'user_reported_interval' : 'unknown', interpretation: 'not_verified_wechat_latency' };
      }
    }
    return { id: row.id, speaker: row.speaker, text: row.text, suggestionId: row.suggestion_id, provenance: row.provenance, recordedAt: row.created_at, wechatTime, replyInterval, createdAt: row.created_at, updatedAt: row.updated_at, ...(row.annotation_json ? { annotation: parse(row.annotation_json) } : {}), ...(row.annotation_revision ? { annotationRevision: row.annotation_revision, annotationUpdatedAt: row.annotation_updated_at } : {}) };
  };
  const touch = (id) => run('UPDATE counterparts SET revision=revision+1,updated_at=? WHERE id=?', timestamp(), id);
  const suggestionSource = (row) => {
    const job = row.origin_job_id ? get('SELECT * FROM model_jobs WHERE id=? AND user_id=? AND counterpart_id=?', row.origin_job_id, row.user_id, row.counterpart_id) : null;
    return { suggestion: { ...parse(row.value_json), createdAt: row.created_at }, originJobId: row.origin_job_id ?? null, status: job?.context_snapshot_json ? 'complete' : 'legacy_incomplete', snapshot: parse(job?.context_snapshot_json), snapshotHash: job?.snapshot_hash ?? null };
  };
  const consumedSource = (userId, counterpartId, suggestionId, text, copy) => copy
    ? get('SELECT * FROM followup_receipts WHERE user_id=? AND counterpart_id=? AND previous_suggestion_id=? AND previous_reply_hash=? AND (copy_receipt_id=? OR (copy_receipt_id IS NULL AND created_at>=?)) ORDER BY created_at LIMIT 1', userId, counterpartId, suggestionId, digest(text), copy.id, copy.copied_at)
    : get('SELECT * FROM followup_receipts WHERE user_id=? AND counterpart_id=? AND previous_suggestion_id=? AND previous_reply_hash=? AND copy_receipt_id IS NULL ORDER BY created_at LIMIT 1', userId, counterpartId, suggestionId, digest(text));
  const pendingState = (row, source, { replyText, copy } = {}) => {
    if (['wait', 'pause'].includes(source.suggestion.action)) return { eligible: false, superseded: false, manualSuperseded: false, copy: null, consumed: null,
      metadata: { pendingEligible: false, pendingCopyReceiptId: null, pendingCopiedAt: null, pendingReplyText: null } };
    const baseline = source.snapshot?.modelInput?.messages;
    const baselineMessages = Array.isArray(baseline) ? new Map(baseline.map((message) => [message.id, message])) : null;
    const laterSelf = all("SELECT * FROM messages WHERE user_id=? AND counterpart_id=? AND speaker='self' ORDER BY seq", row.user_id, row.counterpart_id)
      .filter((message) => baselineMessages ? baselineMessages.get(message.id)?.speaker !== 'self' || baselineMessages.get(message.id)?.text !== message.text : message.updated_at >= row.created_at);
    const changedAnnotations = all('SELECT * FROM messages WHERE user_id=? AND counterpart_id=? AND annotation_updated_at IS NOT NULL', row.user_id, row.counterpart_id)
      .filter((message) => baselineMessages ? message.annotation_revision !== (baselineMessages.get(message.id)?.annotationRevision ?? 0) : message.annotation_revision > 0);
    if (copy === undefined) copy = replyText === undefined
      ? get('SELECT * FROM reply_copy_receipts WHERE user_id=? AND counterpart_id=? AND suggestion_id=? ORDER BY rowid DESC LIMIT 1', row.user_id, row.counterpart_id, row.id)
      : get('SELECT * FROM reply_copy_receipts WHERE user_id=? AND counterpart_id=? AND suggestion_id=? AND copied_text=? ORDER BY rowid DESC LIMIT 1', row.user_id, row.counterpart_id, row.id, replyText);
    const matchingCopy = copy && (replyText === undefined || copy.copied_text === replyText) ? copy : null;
    const copiedAnnotationRevisions = parse(matchingCopy?.annotation_revisions_json);
    // A captured revision proves copying followed the edit even when clocks move
    // backwards. Request replay keeps its original receipt and cannot recapture it.
    const copyRestores = matchingCopy && laterSelf.every((message) => Date.parse(matchingCopy.copied_at) > Date.parse(message.updated_at)) && changedAnnotations.every((message) => copiedAnnotationRevisions?.[message.id] === message.annotation_revision);
    const superseded = (laterSelf.length > 0 || changedAnnotations.length > 0) && !copyRestores;
    const manualSuperseded = superseded && (changedAnnotations.length > 0 || laterSelf.some((message) => message.provenance !== 'inferred_from_followup' && (!matchingCopy || Date.parse(matchingCopy.copied_at) <= Date.parse(message.updated_at))));
    const activeCopy = superseded ? null : matchingCopy;
    const text = replyText ?? activeCopy?.copied_text ?? source.suggestion.reply;
    const consumed = consumedSource(row.user_id, row.counterpart_id, row.id, text, matchingCopy);
    const eligible = !superseded && !consumed;
    return { eligible, superseded, manualSuperseded, copy: eligible ? activeCopy : null, consumed,
      metadata: { pendingEligible: eligible, pendingCopyReceiptId: eligible ? activeCopy?.id ?? null : null, pendingCopiedAt: eligible ? activeCopy?.copied_at ?? null : null, pendingReplyText: eligible ? activeCopy?.copied_text ?? null : null } };
  };
  const suggestionValue = (row) => {
    const source = suggestionSource(row);
    return { ...source.suggestion, ...pendingState(row, source).metadata };
  };
  const styleRuleValue = (row) => ({ id: row.id, ...parse(row.value_json), status: row.status, source: 'user_self_report', sourceReviewId: row.source_review_id ?? null, supersedesId: row.supersedes_id ?? null, ruleHash: row.rule_hash, createdAt: row.created_at, adoptedAt: row.adopted_at ?? null, revokedAt: row.revoked_at ?? null });
  const styleRuleRow = (userId, id) => { const row = get('SELECT * FROM style_rules WHERE id=? AND user_id=?', id, userId); if (!row) throw new BetaError('STYLE_RULE_NOT_FOUND', 404); return row; };
  const styleReplyObservation = (userId, review) => {
    // Read-only decoration: linkage says a chat record exists, never that this
    // self expression was actually sent or that the observed response worked.
    const messageIds = all("SELECT received.id FROM messages received JOIN messages previous ON received.reply_to_message_id=previous.id WHERE received.user_id=? AND received.counterpart_id=? AND received.speaker='other' AND previous.user_id=? AND previous.counterpart_id=? AND previous.speaker='self' AND previous.suggestion_id=? AND previous.text=? ORDER BY received.seq", userId, review.counterpartId, userId, review.counterpartId, review.suggestionId, review.ownVersion).map(({ id }) => id);
    return { status: messageIds.length ? 'recorded' : 'unknown', assessment: 'unassessed', messageIds };
  };
  const jobValue = (row) => row ? ({ id: row.id, userId: row.user_id, counterpartId: row.counterpart_id, operation: row.operation, requestId: row.request_id, contextHash: row.context_hash, knowledgeHash: row.knowledge_hash, state: row.state, result: parse(row.result_json), errorCode: row.error_code, createdAt: row.created_at, updatedAt: row.updated_at, workerId: row.worker_id, cacheOf: row.cache_of }) : null;
  const budget = (subject, forDay) => { run('INSERT OR IGNORE INTO provider_budget(subject,day) VALUES(?,?)', subject, forDay); return get('SELECT * FROM provider_budget WHERE subject=? AND day=?', subject, forDay); };
  const replyBudget = (userId, forDay) => { run('INSERT OR IGNORE INTO reply_daily_usage(user_id,day) VALUES(?,?)', userId, forDay); return get('SELECT * FROM reply_daily_usage WHERE user_id=? AND day=?', userId, forDay); };
  const limitedReplies = (account) => account.plan === 'free' && account.role !== 'owner';
  const providerLimit = (account) => account.plan === 'paid' ? paidProviderDailyLimit : freeProviderDailyLimit;
  const quota = (userId) => {
    const account = user(userId);
    const currentDay = day();
    const local = budget(userId, currentDay), global = budget('global', currentDay);
    const currentReplyDay = replyDay(), replies = replyBudget(userId, currentReplyDay);
    return {
      classificationRemaining: account.plan === 'paid' ? null : Math.max(0, 3 - account.classification_used - account.classification_reserved),
      providerRemaining: Math.max(0, Math.min(providerLimit(account) - local.used - local.reserved, globalProviderDailyLimit - global.used - global.reserved)),
      providerDay: currentDay,
      dailyReplyRemaining: limitedReplies(account) ? Math.max(0, 3 - replies.used - replies.reserved) : null,
      replyDay: currentReplyDay, replyTimeZone: 'Asia/Shanghai',
    };
  };
  function releaseJob(row, code) {
    if (!row || !['reserved', 'running'].includes(row.state)) return;
    if (row.classification_reservation) run('UPDATE users SET classification_reserved=MAX(0,classification_reserved-1) WHERE id=?', row.user_id);
    if (row.reply_reservation) run('UPDATE reply_daily_usage SET reserved=MAX(0,reserved-1) WHERE user_id=? AND day=?', row.user_id, row.reply_day);
    if (row.provider_reservation) {
      for (const subject of [row.user_id, 'global']) run('UPDATE provider_budget SET reserved=MAX(0,reserved-1) WHERE subject=? AND day=?', subject, row.budget_day);
    }
    run("UPDATE model_jobs SET state='failed',error_code=?,classification_reservation=0,reply_reservation=0,provider_reservation=0,updated_at=? WHERE id=?", code, timestamp(), row.id);
    run("UPDATE model_jobs SET state='failed',error_code=?,updated_at=? WHERE cache_of=? AND state='linked'", code, timestamp(), row.id);
  }

  const store = {
    dataDir: directory,
    close: () => db.close(),
    getUser: (id) => safeUser(user(id)),
    // Startup helpers receive a safe view; no route exposes name-based lookup.
    getUserByUsername: (username) => typeof username === 'string' ? safeUser(get('SELECT * FROM users WHERE normalized_username=?', username.normalize('NFC').trim().toLocaleLowerCase('en-US'))) : null,
    listUsers: (ownerId) => { owner(ownerId); return all('SELECT * FROM users ORDER BY created_at').map(safeUser); },
    quota,
    async register({ invite, username, password }) {
      const checked = credentials(username, password);
      if (typeof invite !== 'string' || invite.length > 200) throw new BetaError('INVITE_INVALID');
      const passwordHash = await hashPassword(checked.password);
      return transaction(() => {
        const invitation = get('SELECT * FROM invites WHERE token_hash=?', digest(invite));
        if (!invitation || invitation.used_by || invitation.expires_at <= now()) throw new BetaError('INVITE_INVALID');
        if (get('SELECT id FROM users WHERE normalized_username=?', checked.normalized)) throw new BetaError('USERNAME_UNAVAILABLE', 409);
        const id = randomUUID(), createdAt = timestamp();
        run('INSERT INTO users(id,username,normalized_username,password_hash,plan,role,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', id, checked.username, checked.normalized, passwordHash, invitation.plan, 'user', createdAt, createdAt);
        run('UPDATE invites SET used_by=? WHERE token_hash=?', id, digest(invite));
        audit(id, 'account_registered', id, { plan: invitation.plan });
        return safeUser(user(id));
      });
    },
    async authenticate({ username, password }) {
      if (typeof username !== 'string' || typeof password !== 'string' || username.length > 40 || password.length > 128) throw new BetaError('LOGIN_FAILED', 401);
      const row = get('SELECT * FROM users WHERE normalized_username=?', username.normalize('NFC').trim().toLocaleLowerCase('en-US'));
      if (!(await passwordMatches(password, row?.password_hash))) throw new BetaError('LOGIN_FAILED', 401);
      return safeUser(row);
    },
    createSession(userId) {
      user(userId);
      const rawToken = token(), csrfToken = token(), expiresAt = now() + 7 * 86400_000;
      run('INSERT INTO sessions VALUES(?,?,?,?)', digest(rawToken), userId, csrfToken, expiresAt);
      return { token: rawToken, csrfToken, expiresAt };
    },
    lookupSession(rawToken) {
      if (typeof rawToken !== 'string' || rawToken.length > 200) return null;
      const row = get('SELECT sessions.*,users.username,users.plan,users.role FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=? AND expires_at>?', digest(rawToken), now());
      return row ? { user: { id: row.user_id, username: row.username, plan: row.plan, role: row.role }, csrfToken: row.csrf_token } : null;
    },
    removeSession: (rawToken) => run('DELETE FROM sessions WHERE token_hash=?', digest(rawToken)),
    createInvite({ ownerId, plan, expiresInHours = 72 }) {
      owner(ownerId);
      if (!['free', 'paid'].includes(plan) || !Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > 720) throw new BetaError('INVITE_CONFIGURATION_INVALID');
      const invite = token();
      run('INSERT INTO invites VALUES(?,?,?,?,?,NULL)', digest(invite), plan, ownerId, timestamp(), now() + expiresInHours * 3600_000);
      audit(ownerId, 'invite_created', null, { plan, expiresInHours });
      return { invite };
    },
    updatePlan({ ownerId, userId, plan }) {
      owner(ownerId); user(userId);
      if (!['free', 'paid'].includes(plan)) throw new BetaError('PLAN_INVALID');
      run('UPDATE users SET plan=?,updated_at=? WHERE id=?', plan, timestamp(), userId);
      audit(ownerId, 'plan_changed', userId, { plan });
      return safeUser(user(userId));
    },
    createMcpToken({ ownerId, userId }) {
      owner(ownerId); user(userId);
      const rawToken = token(), expiresAt = now() + 30 * 86400_000;
      transaction(() => {
        run('DELETE FROM mcp_tokens WHERE user_id=?', userId);
        run('INSERT INTO mcp_tokens VALUES(?,?,?,?,?)', digest(rawToken), userId, ownerId, timestamp(), expiresAt);
        audit(ownerId, 'mcp_token_issued', userId, { expiresAt });
      });
      return { token: rawToken, expiresAt };
    },
    lookupMcpToken(rawToken) {
      if (typeof rawToken !== 'string' || rawToken.length > 200) return null;
      const row = get('SELECT users.* FROM mcp_tokens JOIN users ON users.id=mcp_tokens.user_id WHERE token_hash=? AND expires_at>?', digest(rawToken), now());
      return safeUser(row);
    },
    getProfile(userId) { user(userId); const row = get('SELECT * FROM profiles WHERE user_id=?', userId); return row ? { ...parse(row.value_json), updatedAt: row.updated_at } : null; },
    putProfile(userId, value) {
      user(userId);
      run('INSERT INTO profiles VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at', userId, json(value), timestamp());
      run('UPDATE users SET style_revision=style_revision+1 WHERE id=?', userId);
      audit(userId, 'profile_updated', userId, { questionnaireKind: value.questionnaire?.kind });
      return this.getProfile(userId);
    },
    getStyleLearning(userId) {
      const account = user(userId);
      const rules = all('SELECT * FROM style_rules WHERE user_id=? ORDER BY created_at,rowid', userId).map(styleRuleValue);
      const reviews = all('SELECT * FROM style_reviews WHERE user_id=? ORDER BY created_at DESC,rowid DESC', userId).map((row) => {
        const record = parse(row.value_json);
        return { id: row.id, ...record, replyObservation: styleReplyObservation(userId, record), createdAt: row.created_at };
      });
      return { revision: account.style_revision, activeRevision: account.active_style_revision, rules, reviews };
    },
    getAppliedPersonalStyle(userId) {
      const account = user(userId);
      return appliedPersonalStyle(all("SELECT * FROM style_rules WHERE user_id=? AND status='adopted' ORDER BY created_at,rowid", userId).map(styleRuleValue), account.active_style_revision);
    },
    saveProfileAndStyle(userId, value, styleInput) {
      const parsed = styleInput === undefined ? null : StyleLearningInputSchema.safeParse(styleInput);
      if (parsed && !parsed.success) throw new BetaError('INVALID_STYLE_LEARNING');
      const learning = parsed?.data;
      return transaction(() => {
        const account = user(userId);
        const payloadHash = learning ? digest(json({ profile: value, styleLearning: learning })) : null;
        if (learning) {
          const receipt = get('SELECT * FROM style_save_receipts WHERE user_id=? AND request_id=?', userId, learning.requestId);
          if (receipt) {
            if (receipt.payload_hash !== payloadHash) throw new BetaError('STYLE_REQUEST_CONFLICT', 409);
            return { profile: this.getProfile(userId), styleLearning: { ...this.getStyleLearning(userId), cached: true } };
          }
          if (account.style_revision !== learning.expectedRevision) throw new BetaError('STYLE_REVISION_CONFLICT', 409);
        }
        this.putProfile(userId, value);
        let reviewId = null, changedRuleId = null, activeChanged = false;
        if (learning?.review) {
          const input = learning.review;
          counterpartRow(userId, input.counterpartId);
          const source = this.getSuggestionCase(userId, input.counterpartId, input.suggestionId);
          const record = { ...input, source: 'user_self_report', version: STYLE_REVIEW_VERSION,
            originalSuggestion: { id: source.suggestion.id, reply: source.suggestion.reply, originJobId: source.originJobId, knowledgeHash: source.suggestion.knowledgeHash, contextStatus: source.status, snapshotHash: source.snapshotHash },
            replyObservation: styleReplyObservation(userId, input) };
          reviewId = randomUUID();
          run('INSERT INTO style_reviews VALUES(?,?,?,?,?)', reviewId, userId, input.counterpartId, json(record), timestamp());
          audit(userId, 'style_review_saved', reviewId, { suggestionId: input.suggestionId, reasonKind: input.reasonKind, source: 'user_self_report' });
        }
        const change = learning?.ruleChange;
        if (change) {
          const activeCount = () => get("SELECT COUNT(*) AS count FROM style_rules WHERE user_id=? AND status='adopted'", userId).count;
          const assertCapacity = (supersedes) => { if (activeCount() - (supersedes?.status === 'adopted' ? 1 : 0) >= MAX_ACTIVE_STYLE_RULES) throw new BetaError('STYLE_ACTIVE_LIMIT'); };
          const revoke = (row) => {
            if (row.status === 'revoked') return;
            run("UPDATE style_rules SET status='revoked',revoked_at=? WHERE id=?", timestamp(), row.id);
            if (row.status === 'adopted') activeChanged = true;
            audit(userId, 'style_rule_revoked', row.id, { previousStatus: row.status });
          };
          if (change.type === 'propose' || change.type === 'adopt_new') {
            const supersedes = change.supersedesId ? styleRuleRow(userId, change.supersedesId) : null;
            const adopted = change.type === 'adopt_new';
            if (adopted && supersedes?.status === 'revoked') throw new BetaError('STYLE_RULE_STATE_INVALID', 409);
            if (adopted) assertCapacity(supersedes);
            changedRuleId = randomUUID();
            run('INSERT INTO style_rules VALUES(?,?,?,?,?,?,?,?,?,NULL)', changedRuleId, userId, json(change.rule), adopted ? 'adopted' : 'candidate', reviewId, change.supersedesId ?? null, digest(json(change.rule)), timestamp(), adopted ? timestamp() : null);
            if (adopted) { if (supersedes) revoke(supersedes); activeChanged = true; }
            audit(userId, adopted ? 'style_rule_adopted' : 'style_rule_proposed', changedRuleId, { target: change.rule.target, source: 'user_self_report', supersedesId: change.supersedesId ?? null });
          } else if (change.type === 'adopt') {
            const candidate = styleRuleRow(userId, change.candidateId);
            if (candidate.status !== 'candidate') throw new BetaError('STYLE_RULE_STATE_INVALID', 409);
            const supersedes = candidate.supersedes_id ? styleRuleRow(userId, candidate.supersedes_id) : null;
            if (supersedes?.status === 'revoked') throw new BetaError('STYLE_RULE_STATE_INVALID', 409);
            assertCapacity(supersedes);
            if (supersedes) revoke(supersedes);
            run("UPDATE style_rules SET status='adopted',adopted_at=? WHERE id=?", timestamp(), candidate.id);
            changedRuleId = candidate.id; activeChanged = true;
            audit(userId, 'style_rule_adopted', candidate.id, { source: 'user_self_report', supersedesId: candidate.supersedes_id ?? null });
          } else {
            const rule = styleRuleRow(userId, change.ruleId);
            revoke(rule); changedRuleId = rule.id;
          }
        }
        if (activeChanged) run('UPDATE users SET active_style_revision=active_style_revision+1 WHERE id=?', userId);
        if (learning) run('INSERT INTO style_save_receipts VALUES(?,?,?,?,?)', userId, learning.requestId, payloadHash, json({ reviewId, ruleId: changedRuleId }), timestamp());
        return { profile: this.getProfile(userId), styleLearning: { ...this.getStyleLearning(userId), cached: false } };
      });
    },
    listCounterparts(userId) { user(userId); return all('SELECT * FROM counterparts WHERE user_id=? ORDER BY updated_at DESC', userId).map(counterpartValue); },
    getCounterpart: (userId, id) => counterpartValue(counterpartRow(userId, id)),
    putCounterpart(userId, value, id) {
      user(userId);
      if (id) { counterpartRow(userId, id); run('UPDATE counterparts SET value_json=?,revision=revision+1,updated_at=? WHERE id=? AND user_id=?', json(value), timestamp(), id, userId); }
      else { id = randomUUID(); run('INSERT INTO counterparts VALUES(?,?,?,1,?,?)', id, userId, json(value), timestamp(), timestamp()); }
      audit(userId, 'counterpart_saved', id);
      return this.getCounterpart(userId, id);
    },
    deleteCounterpart(userId, id) {
      counterpartRow(userId, id);
      transaction(() => {
        for (const row of all("SELECT * FROM model_jobs WHERE user_id=? AND counterpart_id=? AND state IN ('reserved','running')", userId, id)) releaseJob(row, 'CONTEXT_DELETED');
        run('DELETE FROM counterparts WHERE id=? AND user_id=?', id, userId);
        audit(userId, 'counterpart_deleted', id);
      });
    },
    listMessages(userId, counterpartId) { counterpartRow(userId, counterpartId); return all('SELECT * FROM messages WHERE user_id=? AND counterpart_id=? ORDER BY seq', userId, counterpartId).map(messageValue); },
    putMessage(userId, counterpartId, value, id) {
      counterpartRow(userId, counterpartId);
      return transaction(() => {
        if (id) {
          const existing = get('SELECT * FROM messages WHERE id=? AND user_id=? AND counterpart_id=?', id, userId, counterpartId);
          if (!existing) throw new BetaError('MESSAGE_NOT_FOUND', 404);
          run("UPDATE messages SET speaker=?,text=?,provenance=?,updated_at=? WHERE id=?", value.speaker, value.text, existing.provenance === 'inferred_from_followup' ? 'inferred_from_followup' : 'user_entered_edit', timestamp(), id);
          if (existing.speaker !== value.speaker) {
            run('UPDATE messages SET reply_to_message_id=NULL,reply_interval_json=NULL WHERE id=?', id);
            run('UPDATE messages SET reply_to_message_id=NULL,reply_interval_json=NULL WHERE user_id=? AND counterpart_id=? AND reply_to_message_id=?', userId, counterpartId, id);
          }
        } else {
          id = randomUUID();
          run('INSERT INTO messages(id,user_id,counterpart_id,speaker,text,suggestion_id,provenance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', id, userId, counterpartId, value.speaker, value.text, value.suggestionId ?? null, value.suggestionId ? 'user_confirmed_record' : 'user_entered', timestamp(), timestamp());
        }
        touch(counterpartId);
        audit(userId, 'message_saved', id, { speaker: value.speaker });
        return messageValue(get('SELECT * FROM messages WHERE id=?', id));
      });
    },
    deleteMessage(userId, counterpartId, id) {
      counterpartRow(userId, counterpartId);
      transaction(() => {
        const removed = run('DELETE FROM messages WHERE id=? AND user_id=? AND counterpart_id=?', id, userId, counterpartId);
        if (!removed.changes) throw new BetaError('MESSAGE_NOT_FOUND', 404);
        run('UPDATE messages SET reply_to_message_id=NULL,reply_interval_json=NULL WHERE user_id=? AND counterpart_id=? AND reply_to_message_id=?', userId, counterpartId, id);
        touch(counterpartId); audit(userId, 'message_deleted', id);
      });
    },
    putMessageTime(userId, counterpartId, id, actualWechatAt) {
      counterpartRow(userId, counterpartId);
      const at = actualWechatAt === null ? null : new Date(actualWechatAt).toISOString();
      if (at && Date.parse(at) > now()) throw new BetaError('MESSAGE_TIME_INVALID');
      return transaction(() => {
        const row = get('SELECT * FROM messages WHERE id=? AND user_id=? AND counterpart_id=?', id, userId, counterpartId);
        if (!row) throw new BetaError('MESSAGE_NOT_FOUND', 404);
        const prior = parse(row.wechat_time_json);
        if ((prior?.at ?? null) !== at) {
          const recorded = at ? { at, source: 'user_reported', editedAt: timestamp() } : null;
          run('UPDATE messages SET wechat_time_json=?,updated_at=? WHERE id=?', recorded ? json(recorded) : null, timestamp(), id);
          touch(counterpartId); audit(userId, 'message_time_reported', id, { source: 'user_reported', removed: at === null });
        }
        return messageValue(get('SELECT * FROM messages WHERE id=?', id));
      });
    },
    putMessageAnnotation(userId, counterpartId, id, annotationText) {
      counterpartRow(userId, counterpartId);
      if (typeof annotationText !== 'string' || annotationText.trim().length > 5_000) throw new BetaError('MESSAGE_ANNOTATION_INVALID');
      const content = annotationText.trim();
      return transaction(() => {
        const row = get('SELECT * FROM messages WHERE id=? AND user_id=? AND counterpart_id=?', id, userId, counterpartId);
        if (!row) throw new BetaError('MESSAGE_NOT_FOUND', 404);
        if ((parse(row.annotation_json)?.text ?? '') !== content) {
          const annotation = content ? { text: content, source: 'user_annotation', updatedAt: timestamp() } : null;
          run('UPDATE messages SET annotation_json=?,annotation_updated_at=?,annotation_revision=annotation_revision+1 WHERE id=?', annotation ? json(annotation) : null, timestamp(), id);
          touch(counterpartId); audit(userId, 'message_annotation_saved', id, { source: 'user_annotation', removed: !content });
        }
        return messageValue(get('SELECT * FROM messages WHERE id=?', id));
      });
    },
    getMeeting(userId, counterpartId) { counterpartRow(userId, counterpartId); const row = get('SELECT * FROM meetings WHERE user_id=? AND counterpart_id=?', userId, counterpartId); return row ? parse(row.value_json) : { status: 'none', time: '', place: '', note: '' }; },
    putMeeting(userId, counterpartId, value) {
      counterpartRow(userId, counterpartId);
      run('INSERT INTO meetings VALUES(?,?,?,?) ON CONFLICT(counterpart_id) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at', counterpartId, userId, json(value), timestamp());
      audit(userId, 'meeting_saved', counterpartId, { status: value.status });
      return value;
    },
    listSuggestions(userId, counterpartId) { counterpartRow(userId, counterpartId); return all('SELECT * FROM suggestions WHERE user_id=? AND counterpart_id=? ORDER BY rowid', userId, counterpartId).map(suggestionValue); },
    getSuggestion(userId, counterpartId, id) { counterpartRow(userId, counterpartId); const row = get('SELECT * FROM suggestions WHERE id=? AND user_id=? AND counterpart_id=?', id, userId, counterpartId); if (!row) throw new BetaError('SUGGESTION_NOT_FOUND', 404); return suggestionValue(row); },
    getSuggestionCase(userId, counterpartId, id) {
      counterpartRow(userId, counterpartId);
      const row = get('SELECT * FROM suggestions WHERE id=? AND user_id=? AND counterpart_id=?', id, userId, counterpartId);
      if (!row) throw new BetaError('SUGGESTION_NOT_FOUND', 404);
      const source = suggestionSource(row);
      return { ...source, suggestion: { ...source.suggestion, ...pendingState(row, source).metadata } };
    },
    recordReplyCopy(userId, counterpartId, suggestionId, { copiedText, requestId }) {
      counterpartRow(userId, counterpartId);
      return transaction(() => {
        const source = this.getSuggestionCase(userId, counterpartId, suggestionId);
        if (['wait', 'pause'].includes(source.suggestion.action)) throw new BetaError('SUGGESTION_NOT_SENDABLE', 409);
        const text = copiedText ?? source.suggestion.reply;
        const payloadHash = digest(json({ counterpartId, suggestionId, text }));
        const existing = get('SELECT * FROM reply_copy_receipts WHERE user_id=? AND request_id=?', userId, requestId);
        if (existing) {
          if (existing.payload_hash !== payloadHash) throw new BetaError('COPY_REQUEST_CONFLICT', 409);
          return { copyReceipt: { id: existing.id, suggestionId, copiedAt: existing.copied_at, provenance: 'clipboard_copied' }, cached: true };
        }
        const id = randomUUID(), copiedAt = timestamp();
        const annotationRevisions = Object.fromEntries(all('SELECT id,annotation_revision FROM messages WHERE user_id=? AND counterpart_id=? AND annotation_revision>0', userId, counterpartId).map((message) => [message.id, message.annotation_revision]));
        run('INSERT INTO reply_copy_receipts(id,user_id,counterpart_id,suggestion_id,request_id,payload_hash,copied_text,copied_at,annotation_revisions_json) VALUES(?,?,?,?,?,?,?,?,?)', id, userId, counterpartId, suggestionId, requestId, payloadHash, text, copiedAt, json(annotationRevisions));
        audit(userId, 'reply_copy_reported', id, { suggestionId, provenance: 'clipboard_copied', sendingVerified: false });
        return { copyReceipt: { id, suggestionId, copiedAt, provenance: 'clipboard_copied' }, cached: false };
      });
    },
    recordFollowup(userId, counterpartId, { text, previousSuggestionId, previousReplyText, previousCopyReceiptId, requestId }) {
      counterpartRow(userId, counterpartId);
      return transaction(() => {
        const payloadHash = digest(json({ counterpartId, text, previousSuggestionId: previousSuggestionId ?? null, previousReplyText: previousReplyText ?? null, previousCopyReceiptId: previousCopyReceiptId ?? null }));
        const prior = get('SELECT * FROM followup_receipts WHERE user_id=? AND request_id=?', userId, requestId);
        if (prior) {
          if (prior.payload_hash !== payloadHash) throw new BetaError('FOLLOWUP_REQUEST_CONFLICT', 409);
          return { ...parse(prior.result_json), cached: true };
        }
        let source = previousSuggestionId ? this.getSuggestionCase(userId, counterpartId, previousSuggestionId) : null;
        // Older clients may attach their editable text to a pacing suggestion.
        // Preserve the incoming message without inventing a preceding self turn.
        const noReply = ['wait', 'pause'].includes(source?.suggestion.action);
        let associatedSuggestionId = noReply ? undefined : previousSuggestionId, associatedReplyText = noReply ? undefined : previousReplyText;
        if (noReply) source = null;
        let copy;
        if (!noReply && previousCopyReceiptId) {
          copy = get('SELECT * FROM reply_copy_receipts WHERE id=? AND user_id=? AND counterpart_id=?', previousCopyReceiptId, userId, counterpartId);
          if (!copy || copy.suggestion_id !== previousSuggestionId) throw new BetaError('COPY_RECEIPT_NOT_FOUND', 404);
          if (copy.copied_text !== previousReplyText) copy = null;
        } else if (source && previousReplyText) copy = get('SELECT * FROM reply_copy_receipts WHERE user_id=? AND counterpart_id=? AND suggestion_id=? AND copied_text=? ORDER BY rowid DESC LIMIT 1', userId, counterpartId, previousSuggestionId, previousReplyText);
        if (source) {
          const row = get('SELECT * FROM suggestions WHERE id=? AND user_id=? AND counterpart_id=?', previousSuggestionId, userId, counterpartId);
          const state = pendingState(row, source, { replyText: previousReplyText, copy });
          if (state.consumed && !state.manualSuperseded) {
            if (state.consumed.counterpart_text_hash !== digest(text)) throw new BetaError('FOLLOWUP_SOURCE_ALREADY_LINKED', 409);
            const result = parse(state.consumed.result_json);
            run('INSERT INTO followup_receipts(id,user_id,counterpart_id,request_id,payload_hash,result_json,created_at,previous_suggestion_id,previous_reply_hash,counterpart_text_hash,copy_receipt_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)', randomUUID(), userId, counterpartId, requestId, payloadHash, state.consumed.result_json, timestamp(), previousSuggestionId, digest(previousReplyText), digest(text), state.consumed.copy_receipt_id ?? null);
            return { ...result, cached: true };
          }
          if (!state.eligible) { source = null; copy = null; associatedSuggestionId = undefined; associatedReplyText = undefined; }
          else copy = state.copy;
        }
        const createdAt = timestamp();
        const fromAt = copy?.copied_at ?? source?.suggestion.createdAt ?? null;
        const delta = fromAt ? Date.parse(createdAt) - Date.parse(fromAt) : null;
        const validClock = delta !== null && Number.isSafeInteger(delta) && delta >= 0;
        const timing = { fromAt, toAt: createdAt, elapsedMs: validClock ? delta : null, fromSource: copy ? 'clipboard_copied' : source ? 'suggestion_prepared' : 'unknown', toSource: 'counterpart_text_recorded', reliability: validClock ? copy ? 'app_interval_estimate' : 'weak_preparation_estimate' : 'unknown', interpretation: 'not_verified_wechat_latency' };
        const insertMessage = (speaker, content, suggestionId, provenance, interval) => {
          const id = randomUUID();
          run('INSERT INTO messages(id,user_id,counterpart_id,speaker,text,suggestion_id,provenance,created_at,updated_at,reply_interval_json) VALUES(?,?,?,?,?,?,?,?,?,?)', id, userId, counterpartId, speaker, content, suggestionId ?? null, provenance, createdAt, createdAt, interval ? json(interval) : null);
          return messageValue(get('SELECT * FROM messages WHERE id=?', id));
        };
        const lastRecorded = get('SELECT id,speaker FROM messages WHERE user_id=? AND counterpart_id=? ORDER BY seq DESC LIMIT 1', userId, counterpartId);
        const previousMessage = associatedReplyText ? insertMessage('self', associatedReplyText, associatedSuggestionId, 'inferred_from_followup', null) : null;
        const message = insertMessage('other', text, null, 'user_entered', timing);
        const linkedSelf = previousMessage?.id ?? (lastRecorded?.speaker === 'self' ? lastRecorded.id : null);
        if (linkedSelf) run('UPDATE messages SET reply_to_message_id=? WHERE id=?', linkedSelf, message.id);
        let feedback = null;
        if (previousMessage) {
          const id = randomUUID();
          const envelope = { id, createdAt, sourceMode: 'beta_followup', sourceAccountId: userId, stage: 'raw_untrusted', outcome: 'unknown', consent: false, automaticPromotionAllowed: false,
            payload: { suggestionId: associatedSuggestionId ?? '', actualSentText: associatedReplyText, counterpartReply: text, observation: '', kind: 'uncertain', consent: false },
            caseEvidence: { originJobId: source?.originJobId ?? null, contextStatus: source?.status ?? 'legacy_incomplete', suggestionId: associatedSuggestionId ?? null, previousMessage, counterpartMessage: message, timing, copyReceiptId: copy?.id ?? null, actualSend: 'inferred_from_followup', outcomeSource: 'user_reported' } };
          run('INSERT INTO feedback VALUES(?,?,?,?,?,NULL,NULL,?,?)', id, userId, counterpartId, 'raw_untrusted', json(envelope), createdAt, createdAt);
          feedback = { id, stage: 'raw_untrusted' };
          audit(userId, 'followup_feedback_received', id, { stage: 'raw_untrusted', consent: false, actualSend: 'inferred_from_followup', outcome: 'unknown' });
        }
        touch(counterpartId);
        const result = { message, previousMessage, feedback, timing };
        run('INSERT INTO followup_receipts(id,user_id,counterpart_id,request_id,payload_hash,result_json,created_at,previous_suggestion_id,previous_reply_hash,counterpart_text_hash,copy_receipt_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)', randomUUID(), userId, counterpartId, requestId, payloadHash, json(result), createdAt, associatedSuggestionId ?? null, associatedReplyText ? digest(associatedReplyText) : null, digest(text), copy?.id ?? null);
        audit(userId, 'followup_recorded', message.id, { previousSuggestionId: associatedSuggestionId ?? null, ignoredSuggestionId: previousSuggestionId && !associatedSuggestionId ? previousSuggestionId : null, inferredPreviousReply: Boolean(previousMessage) });
        return { ...result, cached: false };
      });
    },
    findSentMessage(userId, counterpartId, suggestionId, actualSentText) { counterpartRow(userId, counterpartId); return messageValue(get("SELECT * FROM messages WHERE user_id=? AND counterpart_id=? AND suggestion_id=? AND speaker='self' AND text=? AND provenance='user_confirmed_record' ORDER BY seq DESC LIMIT 1", userId, counterpartId, suggestionId, actualSentText)); },
    latestSuccessful(userId, counterpartId, operation, contextHash) { counterpartRow(userId, counterpartId); return jobValue(get("SELECT * FROM model_jobs WHERE user_id=? AND counterpart_id=? AND operation=? AND context_hash=? AND state='succeeded' ORDER BY updated_at DESC LIMIT 1", userId, counterpartId, operation, contextHash)); },
    latestSuccessfulForContexts(userId, counterpartId, operation, contextHashes) {
      counterpartRow(userId, counterpartId);
      if (!Array.isArray(contextHashes) || contextHashes.length !== 2 || contextHashes.some((hash) => typeof hash !== 'string')) throw new BetaError('INPUT_INVALID');
      return jobValue(get("SELECT * FROM model_jobs WHERE user_id=? AND counterpart_id=? AND operation=? AND context_hash IN (?,?) AND state='succeeded' ORDER BY rowid DESC LIMIT 1", userId, counterpartId, operation, ...contextHashes));
    },
    hasModelAttempt(userId, counterpartId, operation, contextHash) { counterpartRow(userId, counterpartId); return Boolean(get('SELECT id FROM model_jobs WHERE user_id=? AND counterpart_id=? AND operation=? AND context_hash=? LIMIT 1', userId, counterpartId, operation, contextHash)); },
    latestCoachPlan(userId, counterpartId, baseContextHash) {
      counterpartRow(userId, counterpartId);
      const row = get("SELECT * FROM model_jobs WHERE user_id=? AND counterpart_id=? AND operation='coach_plan' AND state='succeeded' AND cache_of IS NULL AND json_extract(context_snapshot_json,'$.baseContextHash')=? ORDER BY updated_at DESC,rowid DESC LIMIT 1", userId, counterpartId, baseContextHash);
      if (!row) return null;
      return { plan: parse(row.context_snapshot_json).request.plan, planAssessment: parse(row.result_json).planAssessment };
    },
    listJobs(userId, counterpartId) { counterpartRow(userId, counterpartId); return all('SELECT * FROM model_jobs WHERE user_id=? AND counterpart_id=? ORDER BY created_at DESC LIMIT 30', userId, counterpartId).map(jobValue); },
    previousClassification(userId, counterpartId) {
      counterpartRow(userId, counterpartId);
      const row = get("SELECT * FROM model_jobs WHERE user_id=? AND counterpart_id=? AND operation='classify' AND state='succeeded' AND cache_of IS NULL ORDER BY rowid DESC LIMIT 1", userId, counterpartId);
      return row ? { ...jobValue(row), contextSnapshot: parse(row.context_snapshot_json) } : null;
    },
    reserveJob({ userId, counterpartId, operation, requestId, contextHash, knowledgeHash, workerId, providerModel, contextSnapshot }) {
      counterpartRow(userId, counterpartId);
      return transaction(() => {
        const existing = get('SELECT * FROM model_jobs WHERE user_id=? AND operation=? AND request_id=?', userId, operation, requestId);
        if (existing) {
          if (existing.context_hash !== contextHash || existing.counterpart_id !== counterpartId) throw new BetaError('REQUEST_ID_CONTEXT_CONFLICT', 409);
          if (existing.state === 'linked') return { job: jobValue(get('SELECT * FROM model_jobs WHERE id=?', existing.cache_of)), cached: true, fresh: false };
          return { job: jobValue(existing), cached: existing.state === 'succeeded', fresh: false };
        }
        const cached = get("SELECT * FROM model_jobs WHERE user_id=? AND counterpart_id=? AND operation=? AND context_hash=? AND state='succeeded' ORDER BY updated_at DESC LIMIT 1", userId, counterpartId, operation, contextHash);
        const id = randomUUID(), createdAt = timestamp(), currentDay = day();
        if (cached) {
          run('INSERT INTO model_jobs(id,user_id,counterpart_id,operation,request_id,context_hash,knowledge_hash,state,result_json,budget_day,worker_id,provider_model,cache_of,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, userId, counterpartId, operation, requestId, contextHash, knowledgeHash, 'succeeded', cached.result_json, currentDay, workerId, providerModel, cached.id, createdAt, createdAt);
          audit(userId, 'model_job_replayed', id, { operation, cacheOf: cached.id });
          return { job: jobValue(get('SELECT * FROM model_jobs WHERE id=?', id)), cached: true, fresh: false };
        }
        const pending = get("SELECT * FROM model_jobs WHERE user_id=? AND counterpart_id=? AND operation=? AND context_hash=? AND state IN ('reserved','running') LIMIT 1", userId, counterpartId, operation, contextHash);
        if (pending) {
          run('INSERT INTO model_jobs(id,user_id,counterpart_id,operation,request_id,context_hash,knowledge_hash,state,budget_day,worker_id,provider_model,cache_of,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, userId, counterpartId, operation, requestId, contextHash, knowledgeHash, 'linked', currentDay, workerId, providerModel, pending.id, createdAt, createdAt);
          return { job: jobValue(pending), cached: true, fresh: false };
        }
        const account = user(userId), classReservation = operation === 'classify' && account.plan === 'free' ? 1 : 0;
        if (classReservation && account.classification_used + account.classification_reserved >= 3) throw new BetaError('CLASSIFICATION_QUOTA_EXHAUSTED', 402);
        const forReplyDay = replyDay(), replyReservation = operation === 'reply' && limitedReplies(account) ? 1 : 0;
        if (replyReservation) {
          const replies = replyBudget(userId, forReplyDay);
          if (replies.used + replies.reserved >= 3) throw new BetaError('DAILY_REPLY_QUOTA_EXHAUSTED', 402);
        }
        const local = budget(userId, currentDay), global = budget('global', currentDay);
        if (local.used + local.reserved >= providerLimit(account) || global.used + global.reserved >= globalProviderDailyLimit) throw new BetaError('PROVIDER_BUDGET_EXHAUSTED', 429);
        if (classReservation) run('UPDATE users SET classification_reserved=classification_reserved+1 WHERE id=?', userId);
        if (replyReservation) run('UPDATE reply_daily_usage SET reserved=reserved+1 WHERE user_id=? AND day=?', userId, forReplyDay);
        for (const subject of [userId, 'global']) run('UPDATE provider_budget SET reserved=reserved+1 WHERE subject=? AND day=?', subject, currentDay);
        const snapshotJson = contextSnapshot ? json(contextSnapshot) : null;
        run('INSERT INTO model_jobs(id,user_id,counterpart_id,operation,request_id,context_hash,knowledge_hash,state,classification_reservation,provider_reservation,budget_day,worker_id,provider_model,created_at,updated_at,context_snapshot_json,snapshot_hash,reply_reservation,reply_day) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, userId, counterpartId, operation, requestId, contextHash, knowledgeHash, 'reserved', classReservation, 1, currentDay, workerId, providerModel, createdAt, createdAt, snapshotJson, snapshotJson ? digest(snapshotJson) : null, replyReservation, replyReservation ? forReplyDay : null);
        audit(userId, 'model_job_reserved', id, { operation, knowledgeHash, contextHash });
        return { job: jobValue(get('SELECT * FROM model_jobs WHERE id=?', id)), fresh: true, cached: false };
      });
    },
    markJobRunning(id) {
      return transaction(() => {
        const row = get('SELECT * FROM model_jobs WHERE id=?', id);
        if (!row || row.state !== 'reserved') throw new BetaError('JOB_NOT_AVAILABLE', 409);
        for (const subject of [row.user_id, 'global']) run('UPDATE provider_budget SET reserved=MAX(0,reserved-1),used=used+1 WHERE subject=? AND day=?', subject, row.budget_day);
        run("UPDATE model_jobs SET state='running',provider_reservation=0,updated_at=? WHERE id=?", timestamp(), id);
      });
    },
    completeJob(id, result, suggestion) {
      return transaction(() => {
        const row = get('SELECT * FROM model_jobs WHERE id=?', id);
        if (!row || row.state !== 'running') throw new BetaError('JOB_NOT_AVAILABLE', 409);
        if (row.classification_reservation) run('UPDATE users SET classification_reserved=MAX(0,classification_reserved-1),classification_used=classification_used+1 WHERE id=?', row.user_id);
        if (row.reply_reservation) {
          const sendable = typeof suggestion?.reply === 'string' && suggestion.reply.trim().length > 0 && !['wait', 'pause'].includes(suggestion.action);
          run('UPDATE reply_daily_usage SET reserved=MAX(0,reserved-1),used=used+? WHERE user_id=? AND day=?', sendable ? 1 : 0, row.user_id, row.reply_day);
        }
        if (suggestion) run('INSERT INTO suggestions(id,user_id,counterpart_id,value_json,context_hash,knowledge_hash,created_at,origin_job_id) VALUES(?,?,?,?,?,?,?,?)', suggestion.id, row.user_id, row.counterpart_id, json(suggestion), row.context_hash, row.knowledge_hash, timestamp(), id);
        run("UPDATE model_jobs SET state='succeeded',result_json=?,classification_reservation=0,reply_reservation=0,updated_at=? WHERE id=?", json(result), timestamp(), id);
        run("UPDATE model_jobs SET state='succeeded',result_json=?,updated_at=? WHERE cache_of=? AND state='linked'", json(result), timestamp(), id);
        audit(row.user_id, 'model_job_completed', id, { operation: row.operation, knowledgeHash: row.knowledge_hash });
        return jobValue(get('SELECT * FROM model_jobs WHERE id=?', id));
      });
    },
    failJob(id, code, { diagnostics } = {}) { transaction(() => { const row = get('SELECT * FROM model_jobs WHERE id=?', id); releaseJob(row, code); if (row) audit(row.user_id, 'model_job_failed', id, { code, ...(diagnostics === undefined ? {} : { diagnostics }) }); }); },
    recoverAbandonedJobs() { return transaction(() => { const rows = all("SELECT * FROM model_jobs WHERE state IN ('reserved','running')"); for (const row of rows) releaseJob(row, 'JOB_INTERRUPTED'); return rows.length; }); },
    addFeedback(userId, counterpartId, raw) {
      counterpartRow(userId, counterpartId);
      const id = randomUUID(), createdAt = timestamp();
      const source = this.getSuggestionCase(userId, counterpartId, raw.suggestionId);
      const sent = this.findSentMessage(userId, counterpartId, raw.suggestionId, raw.actualSentText);
      const envelope = { id, createdAt, sourceMode: 'beta_account', sourceAccountId: userId, stage: 'raw_untrusted', payload: raw,
        caseEvidence: { originJobId: source.originJobId, contextStatus: source.status, suggestionId: raw.suggestionId, previousMessage: sent, counterpartReply: raw.counterpartReply, actualSend: sent ? 'user_confirmed_record' : 'unconfirmed', outcomeSource: 'user_reported' } };
      run('INSERT INTO feedback VALUES(?,?,?,?,?,NULL,NULL,?,?)', id, userId, counterpartId, 'raw_untrusted', json(envelope), createdAt, createdAt);
      audit(userId, 'feedback_received', id, { stage: 'raw_untrusted' });
      return { id, stage: 'raw_untrusted' };
    },
    getFeedback(ownerId, id) {
      owner(ownerId);
      const row = get('SELECT feedback.*,users.username FROM feedback JOIN users ON users.id=feedback.user_id WHERE feedback.id=?', id);
      if (!row) throw new BetaError('FEEDBACK_NOT_FOUND', 404);
      const raw = parse(row.raw_json);
      const sourceId = raw.caseEvidence?.originJobId;
      const job = sourceId ? get('SELECT * FROM model_jobs WHERE id=? AND user_id=? AND counterpart_id=?', sourceId, row.user_id, row.counterpart_id) : null;
      const caseEvidence = { ...(raw.caseEvidence ?? {}), contextStatus: job?.context_snapshot_json ? 'complete' : 'legacy_incomplete', snapshot: parse(job?.context_snapshot_json), snapshotHash: job?.snapshot_hash ?? null };
      return { id: row.id, counterpartId: row.counterpart_id, user: { id: row.user_id, username: row.username }, stage: row.stage, raw, caseEvidence, cleaning: parse(row.cleaning_json), review: parse(row.review_json), createdAt: row.created_at };
    },
    listFeedback(ownerId) { owner(ownerId); return all('SELECT id FROM feedback ORDER BY created_at DESC LIMIT 500').map((row) => this.getFeedback(ownerId, row.id)); },
    saveCleaning(ownerId, id, candidate) {
      owner(ownerId); const current = this.getFeedback(ownerId, id);
      if (current.review || get('SELECT feedback_id FROM knowledge_approvals WHERE feedback_id=?', id)) throw new BetaError('FEEDBACK_ALREADY_REVIEWED', 409);
      const duplicate = all('SELECT id,cleaning_json FROM feedback WHERE id<>? AND cleaning_json IS NOT NULL', id).find((row) => parse(row.cleaning_json)?.dedupKey === candidate.dedupKey);
      if (duplicate) candidate = { ...candidate, stage: 'quarantined', flags: [...(candidate.flags ?? []), 'duplicate_submission'], duplicateOf: duplicate.id, allowedPurposes: [] };
      run('UPDATE feedback SET stage=?,cleaning_json=?,updated_at=? WHERE id=?', candidate.stage, json(candidate), timestamp(), id);
      audit(ownerId, 'feedback_cleaned', id, { stage: candidate.stage, transformations: candidate.transformations?.length ?? 0 });
      return this.getFeedback(ownerId, id);
    },
    saveReview(ownerId, id, receipt) {
      owner(ownerId); const existing = this.getFeedback(ownerId, id);
      if (existing.review) return existing;
      return transaction(() => {
        const reviewed = { ...receipt, reviewerId: ownerId, reviewedAt: timestamp() };
        run('UPDATE feedback SET stage=?,review_json=?,updated_at=? WHERE id=?', receipt.stage, json(reviewed), timestamp(), id);
        run('INSERT INTO feedback_reviews VALUES(?,?,?,?,?)', randomUUID(), id, ownerId, json(reviewed), timestamp());
        audit(ownerId, 'feedback_reviewed', id, { stage: receipt.stage, purpose: receipt.purpose ?? null });
        return this.getFeedback(ownerId, id);
      });
    },
    beginKnowledgeApproval(ownerId, id, reviewHash, receipt, supplement) {
      owner(ownerId);
      return transaction(() => {
        const existing = get('SELECT * FROM knowledge_approvals WHERE feedback_id=?', id);
        if (existing) { if (existing.review_hash !== reviewHash) throw new BetaError('REVIEW_CONFLICT', 409); return existing; }
        const marker = `<!-- FEEDBACK_APPROVAL:${id} -->`;
        run('INSERT INTO knowledge_approvals VALUES(?,?,?,?,?,?,NULL,?,?)', id, reviewHash, marker, supplement, json(receipt), 'pending', timestamp(), timestamp());
        return get('SELECT * FROM knowledge_approvals WHERE feedback_id=?', id);
      });
    },
    getKnowledgeApproval(ownerId, id) { owner(ownerId); return get('SELECT * FROM knowledge_approvals WHERE feedback_id=?', id) ?? null; },
    finishKnowledgeApproval(ownerId, id, knowledgeHash) {
      owner(ownerId);
      return transaction(() => {
        const approval = get('SELECT * FROM knowledge_approvals WHERE feedback_id=?', id);
        if (!approval) throw new BetaError('APPROVAL_NOT_FOUND', 404);
        if (approval.state === 'committed') return this.getFeedback(ownerId, id);
        run("UPDATE knowledge_approvals SET state='committed',knowledge_hash=?,updated_at=? WHERE feedback_id=?", knowledgeHash, timestamp(), id);
        const receipt = { ...parse(approval.review_json), reviewerId: ownerId, reviewedAt: timestamp(), approvalReceipt: id, knowledgeHash };
        run('UPDATE feedback SET stage=?,review_json=?,updated_at=? WHERE id=?', receipt.stage, json(receipt), timestamp(), id);
        run('INSERT INTO feedback_reviews VALUES(?,?,?,?,?)', randomUUID(), id, ownerId, json(receipt), timestamp());
        audit(ownerId, 'knowledge_supplement_approved', id, { knowledgeHash });
        return this.getFeedback(ownerId, id);
      });
    },
    async seedOwner({ username, password }) {
      const checked = credentials(username, password), passwordHash = await hashPassword(password);
      return transaction(() => {
        const existing = get('SELECT * FROM users WHERE normalized_username=?', checked.normalized);
        if (existing) {
          if (existing.role !== 'owner') throw new BetaError('OWNER_USERNAME_CONFLICT', 409);
          throw new BetaError('OWNER_ALREADY_EXISTS', 409);
        }
        const id = randomUUID(), createdAt = timestamp();
        run('INSERT INTO users(id,username,normalized_username,password_hash,plan,role,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', id, checked.username, checked.normalized, passwordHash, 'paid', 'owner', createdAt, createdAt);
        audit(id, 'owner_seeded', id);
        return safeUser(user(id));
      });
    },
  };
  return store;
}

export async function seedOwner(store, options) { return store.seedOwner(options); }
