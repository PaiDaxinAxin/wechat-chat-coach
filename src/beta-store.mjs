import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { PROJECT_ROOT } from './knowledge.mjs';

const derive = promisify(scrypt);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const json = (value) => JSON.stringify(value);
const parse = (value) => value ? JSON.parse(value) : null;

export class BetaError extends Error {
  constructor(code, status = 400) { super(code); this.name = 'BetaError'; this.code = code; this.status = status; }
}

export function safeUser(row) { return row ? { id: row.id, username: row.username, plan: row.plan, role: row.role } : null; }

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
    );`);
  const get = (sql, ...arguments_) => db.prepare(sql).get(...arguments_);
  const all = (sql, ...arguments_) => db.prepare(sql).all(...arguments_);
  const run = (sql, ...arguments_) => db.prepare(sql).run(...arguments_);
  const timestamp = () => new Date(now()).toISOString();
  const day = () => timestamp().slice(0, 10);
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
  const messageValue = (row) => row ? ({ id: row.id, speaker: row.speaker, text: row.text, suggestionId: row.suggestion_id, provenance: row.provenance, createdAt: row.created_at, updatedAt: row.updated_at }) : null;
  const touch = (id) => run('UPDATE counterparts SET revision=revision+1,updated_at=? WHERE id=?', timestamp(), id);
  const jobValue = (row) => row ? ({ id: row.id, userId: row.user_id, counterpartId: row.counterpart_id, operation: row.operation, requestId: row.request_id, contextHash: row.context_hash, knowledgeHash: row.knowledge_hash, state: row.state, result: parse(row.result_json), errorCode: row.error_code, createdAt: row.created_at, updatedAt: row.updated_at, workerId: row.worker_id, cacheOf: row.cache_of }) : null;
  const budget = (subject, forDay) => { run('INSERT OR IGNORE INTO provider_budget(subject,day) VALUES(?,?)', subject, forDay); return get('SELECT * FROM provider_budget WHERE subject=? AND day=?', subject, forDay); };
  const providerLimit = (account) => account.plan === 'paid' ? paidProviderDailyLimit : freeProviderDailyLimit;
  const quota = (userId) => {
    const account = user(userId);
    const currentDay = day();
    const local = budget(userId, currentDay), global = budget('global', currentDay);
    return {
      classificationRemaining: account.plan === 'paid' ? null : Math.max(0, 3 - account.classification_used - account.classification_reserved),
      providerRemaining: Math.max(0, Math.min(providerLimit(account) - local.used - local.reserved, globalProviderDailyLimit - global.used - global.reserved)),
      providerDay: currentDay,
    };
  };
  function releaseJob(row, code) {
    if (!row || !['reserved', 'running'].includes(row.state)) return;
    if (row.classification_reservation) run('UPDATE users SET classification_reserved=MAX(0,classification_reserved-1) WHERE id=?', row.user_id);
    if (row.provider_reservation) {
      for (const subject of [row.user_id, 'global']) run('UPDATE provider_budget SET reserved=MAX(0,reserved-1) WHERE subject=? AND day=?', subject, row.budget_day);
    }
    run("UPDATE model_jobs SET state='failed',error_code=?,classification_reservation=0,provider_reservation=0,updated_at=? WHERE id=?", code, timestamp(), row.id);
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
      audit(userId, 'profile_updated', userId, { questionnaireKind: value.questionnaire?.kind });
      return this.getProfile(userId);
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
          run("UPDATE messages SET speaker=?,text=?,provenance='user_entered_edit',updated_at=? WHERE id=?", value.speaker, value.text, timestamp(), id);
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
        touch(counterpartId); audit(userId, 'message_deleted', id);
      });
    },
    getMeeting(userId, counterpartId) { counterpartRow(userId, counterpartId); const row = get('SELECT * FROM meetings WHERE user_id=? AND counterpart_id=?', userId, counterpartId); return row ? parse(row.value_json) : { status: 'none', time: '', place: '', note: '' }; },
    putMeeting(userId, counterpartId, value) {
      counterpartRow(userId, counterpartId);
      run('INSERT INTO meetings VALUES(?,?,?,?) ON CONFLICT(counterpart_id) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at', counterpartId, userId, json(value), timestamp());
      audit(userId, 'meeting_saved', counterpartId, { status: value.status });
      return value;
    },
    listSuggestions(userId, counterpartId) { counterpartRow(userId, counterpartId); return all('SELECT * FROM suggestions WHERE user_id=? AND counterpart_id=? ORDER BY created_at', userId, counterpartId).map((row) => ({ ...parse(row.value_json), createdAt: row.created_at })); },
    getSuggestion(userId, counterpartId, id) { counterpartRow(userId, counterpartId); const row = get('SELECT * FROM suggestions WHERE id=? AND user_id=? AND counterpart_id=?', id, userId, counterpartId); if (!row) throw new BetaError('SUGGESTION_NOT_FOUND', 404); return parse(row.value_json); },
    findSentMessage(userId, counterpartId, suggestionId, actualSentText) { counterpartRow(userId, counterpartId); return messageValue(get("SELECT * FROM messages WHERE user_id=? AND counterpart_id=? AND suggestion_id=? AND speaker='self' AND text=? AND provenance='user_confirmed_record' ORDER BY seq DESC LIMIT 1", userId, counterpartId, suggestionId, actualSentText)); },
    latestSuccessful(userId, counterpartId, operation, contextHash) { counterpartRow(userId, counterpartId); return jobValue(get("SELECT * FROM model_jobs WHERE user_id=? AND counterpart_id=? AND operation=? AND context_hash=? AND state='succeeded' ORDER BY updated_at DESC LIMIT 1", userId, counterpartId, operation, contextHash)); },
    listJobs(userId, counterpartId) { counterpartRow(userId, counterpartId); return all('SELECT * FROM model_jobs WHERE user_id=? AND counterpart_id=? ORDER BY created_at DESC LIMIT 30', userId, counterpartId).map(jobValue); },
    previousClassification(userId, counterpartId) { counterpartRow(userId, counterpartId); return jobValue(get("SELECT * FROM model_jobs WHERE user_id=? AND counterpart_id=? AND operation='classify' AND state='succeeded' AND cache_of IS NULL ORDER BY updated_at DESC LIMIT 1", userId, counterpartId)); },
    reserveJob({ userId, counterpartId, operation, requestId, contextHash, knowledgeHash, workerId, providerModel }) {
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
        const local = budget(userId, currentDay), global = budget('global', currentDay);
        if (local.used + local.reserved >= providerLimit(account) || global.used + global.reserved >= globalProviderDailyLimit) throw new BetaError('PROVIDER_BUDGET_EXHAUSTED', 429);
        if (classReservation) run('UPDATE users SET classification_reserved=classification_reserved+1 WHERE id=?', userId);
        for (const subject of [userId, 'global']) run('UPDATE provider_budget SET reserved=reserved+1 WHERE subject=? AND day=?', subject, currentDay);
        run('INSERT INTO model_jobs(id,user_id,counterpart_id,operation,request_id,context_hash,knowledge_hash,state,classification_reservation,provider_reservation,budget_day,worker_id,provider_model,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, userId, counterpartId, operation, requestId, contextHash, knowledgeHash, 'reserved', classReservation, 1, currentDay, workerId, providerModel, createdAt, createdAt);
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
        if (suggestion) run('INSERT INTO suggestions VALUES(?,?,?,?,?,?,?)', suggestion.id, row.user_id, row.counterpart_id, json(suggestion), row.context_hash, row.knowledge_hash, timestamp());
        run("UPDATE model_jobs SET state='succeeded',result_json=?,classification_reservation=0,updated_at=? WHERE id=?", json(result), timestamp(), id);
        run("UPDATE model_jobs SET state='succeeded',result_json=?,updated_at=? WHERE cache_of=? AND state='linked'", json(result), timestamp(), id);
        audit(row.user_id, 'model_job_completed', id, { operation: row.operation, knowledgeHash: row.knowledge_hash });
        return jobValue(get('SELECT * FROM model_jobs WHERE id=?', id));
      });
    },
    failJob(id, code) { transaction(() => { const row = get('SELECT * FROM model_jobs WHERE id=?', id); releaseJob(row, code); if (row) audit(row.user_id, 'model_job_failed', id, { code }); }); },
    recoverAbandonedJobs() { return transaction(() => { const rows = all("SELECT * FROM model_jobs WHERE state IN ('reserved','running')"); for (const row of rows) releaseJob(row, 'JOB_INTERRUPTED'); return rows.length; }); },
    addFeedback(userId, counterpartId, raw) {
      counterpartRow(userId, counterpartId);
      const id = randomUUID(), createdAt = timestamp();
      const envelope = { id, createdAt, sourceMode: 'beta_account', sourceAccountId: userId, stage: 'raw_untrusted', payload: raw };
      run('INSERT INTO feedback VALUES(?,?,?,?,?,NULL,NULL,?,?)', id, userId, counterpartId, 'raw_untrusted', json(envelope), createdAt, createdAt);
      audit(userId, 'feedback_received', id, { stage: 'raw_untrusted' });
      return { id, stage: 'raw_untrusted' };
    },
    getFeedback(ownerId, id) {
      owner(ownerId);
      const row = get('SELECT feedback.*,users.username FROM feedback JOIN users ON users.id=feedback.user_id WHERE feedback.id=?', id);
      if (!row) throw new BetaError('FEEDBACK_NOT_FOUND', 404);
      return { id: row.id, counterpartId: row.counterpart_id, user: { id: row.user_id, username: row.username }, stage: row.stage, raw: parse(row.raw_json), cleaning: parse(row.cleaning_json), review: parse(row.review_json), createdAt: row.created_at };
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
