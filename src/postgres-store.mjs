import { AsyncLocalStorage } from 'node:async_hooks';
import { BetaError, safeUser } from './store-contract.mjs';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { appliedPersonalStyle, MAX_ACTIVE_STYLE_RULES, STYLE_REVIEW_VERSION, StyleLearningInputSchema } from './style-learning.mjs';

const derive = promisify(scrypt);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const json = (value) => JSON.stringify(value);
const parse = (value) => value ? JSON.parse(value) : null;

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


/** Postgres keeps the existing store contract; the caller owns the pool lifecycle.
 * Schema migration is an explicit administrative step, never a cold-start action.
 */
export async function createPostgresStore({
  pool, now = Date.now,
  freeProviderDailyLimit = 10, paidProviderDailyLimit = 10, globalProviderDailyLimit = 100,
  leaseMs = 360_000,
} = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new BetaError('DATABASE_CONFIGURATION_INVALID', 500);
  for (const limit of [freeProviderDailyLimit, paidProviderDailyLimit, globalProviderDailyLimit]) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new BetaError('BUDGET_CONFIGURATION_INVALID');
  }
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 900_000) throw new BetaError('JOB_LEASE_INVALID');
  const scope = new AsyncLocalStorage();
  const transaction = async (callback, { readOnly = false } = {}) => {
    if (scope.getStore()) return callback();
    const client = await pool.connect();
    try {
      await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
      await client.query('SET LOCAL search_path TO chat_coach, pg_catalog');
      await client.query("SET LOCAL statement_timeout = '15000ms'");
      await client.query("SET LOCAL lock_timeout = '10000ms'");
      // Short business transactions only: no network/model work while this lock is held.
      if (!readOnly) await client.query("SELECT pg_advisory_xact_lock(1784961896, 1)");
      const value = await scope.run(client, callback);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  };
  const query = async (sql, args) => {
    const client = scope.getStore();
    if (!client) throw new BetaError('DATABASE_TRANSACTION_REQUIRED', 500);
    return client.query(sql, args);
  };
  const get = async (sql, ...args) => (await query(sql, args)).rows[0];
  const all = async (sql, ...args) => (await query(sql, args)).rows;
  const run = async (sql, ...args) => { const result = await query(sql, args); return { changes: result.rowCount }; };
  const decorate = async (rows, mapper) => {
    const values = [];
    // A transaction owns one client. Keep its dependent decoration queries serial.
    for (const row of rows) values.push(await mapper(row));
    return values;
  };
  const timestamp = () => new Date(now()).toISOString();
  const day = () => timestamp().slice(0, 10);
  try {
    await transaction(async () => {
      const row = await get('SELECT version FROM schema_version WHERE singleton = TRUE');
      if (row?.version !== 1) throw new BetaError('DATABASE_SCHEMA_REQUIRED', 500);
    }, { readOnly: true });
  } catch (error) {
    if (error.code === '42P01') throw new BetaError('DATABASE_SCHEMA_REQUIRED', 500);
    throw error;
  }
  const audit = async (actorId, action, entityId, details = {}) => (await run('INSERT INTO audit_log VALUES($1,$2,$3,$4,$5,$6)', randomUUID(), actorId, action, entityId, json(details), timestamp()));
  const user = async (id) => { const row = (await get('SELECT * FROM users WHERE id=$1', id)); if (!row) throw new BetaError('ACCOUNT_NOT_FOUND', 404); return row; };
  const owner = async (id) => { const row = (await user(id)); if (row.role !== 'owner') throw new BetaError('OWNER_REQUIRED', 403); return row; };
  const counterpartRow = async (userId, id) => { const row = (await get('SELECT * FROM counterparts WHERE id=$1 AND user_id=$2', id, userId)); if (!row) throw new BetaError('COUNTERPART_NOT_FOUND', 404); return row; };
  const counterpartValue = (row) => ({ ...parse(row.value_json), id: row.id, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at });
  const messageValue = async (row) => {
    if (!row) return null;
    const wechatTime = parse(row.wechat_time_json);
    let replyInterval = parse(row.reply_interval_json);
    if (row.reply_to_message_id) {
      const previous = (await get('SELECT speaker,wechat_time_json FROM messages WHERE id=$1 AND user_id=$2 AND counterpart_id=$3', row.reply_to_message_id, row.user_id, row.counterpart_id));
      const sentTime = parse(previous?.wechat_time_json);
      if (row.speaker !== 'other' || previous?.speaker !== 'self') replyInterval = null;
      else if (wechatTime && sentTime) {
        const delta = Date.parse(wechatTime.at) - Date.parse(sentTime.at);
        const valid = Number.isSafeInteger(delta) && delta >= 0;
        replyInterval = { fromAt: sentTime.at, toAt: wechatTime.at, elapsedMs: valid ? delta : null, fromSource: 'user_reported_wechat_sent', toSource: 'user_reported_wechat_received', reliability: valid ? 'user_reported_interval' : 'unknown', interpretation: 'not_verified_wechat_latency' };
      }
    }
    return { id: row.id, speaker: row.speaker, text: row.text, suggestionId: row.suggestion_id, provenance: row.provenance, recordedAt: row.created_at, wechatTime, replyInterval, createdAt: row.created_at, updatedAt: row.updated_at };
  };
  const touch = async (id) => (await run('UPDATE counterparts SET revision=revision+1,updated_at=$1 WHERE id=$2', timestamp(), id));
  const suggestionSource = async (row) => {
    const job = row.origin_job_id ? (await get('SELECT * FROM model_jobs WHERE id=$1 AND user_id=$2 AND counterpart_id=$3', row.origin_job_id, row.user_id, row.counterpart_id)) : null;
    return { suggestion: { ...parse(row.value_json), createdAt: row.created_at }, originJobId: row.origin_job_id ?? null, status: job?.context_snapshot_json ? 'complete' : 'legacy_incomplete', snapshot: parse(job?.context_snapshot_json), snapshotHash: job?.snapshot_hash ?? null };
  };
  const consumedSource = async (userId, counterpartId, suggestionId, text, copy) => copy
    ? (await get('SELECT * FROM followup_receipts WHERE user_id=$1 AND counterpart_id=$2 AND previous_suggestion_id=$3 AND previous_reply_hash=$4 AND (copy_receipt_id=$5 OR (copy_receipt_id IS NULL AND created_at>=$6)) ORDER BY created_at LIMIT 1', userId, counterpartId, suggestionId, digest(text), copy.id, copy.copied_at))
    : (await get('SELECT * FROM followup_receipts WHERE user_id=$1 AND counterpart_id=$2 AND previous_suggestion_id=$3 AND previous_reply_hash=$4 AND copy_receipt_id IS NULL ORDER BY created_at LIMIT 1', userId, counterpartId, suggestionId, digest(text)));
  const pendingState = async (row, source, { replyText, copy } = {}) => {
    if (['wait', 'pause'].includes(source.suggestion.action)) return { eligible: false, superseded: false, manualSuperseded: false, copy: null, consumed: null,
      metadata: { pendingEligible: false, pendingCopyReceiptId: null, pendingCopiedAt: null, pendingReplyText: null } };
    const baseline = source.snapshot?.modelInput?.messages;
    const baselineMessages = Array.isArray(baseline) ? new Map(baseline.map((message) => [message.id, message])) : null;
    const laterSelf = (await all("SELECT * FROM messages WHERE user_id=$1 AND counterpart_id=$2 AND speaker='self' ORDER BY seq", row.user_id, row.counterpart_id))
      .filter((message) => baselineMessages ? baselineMessages.get(message.id)?.speaker !== 'self' || baselineMessages.get(message.id)?.text !== message.text : message.updated_at >= row.created_at);
    if (copy === undefined) copy = replyText === undefined
      ? (await get('SELECT * FROM reply_copy_receipts WHERE user_id=$1 AND counterpart_id=$2 AND suggestion_id=$3 ORDER BY copied_at DESC,_ordinal DESC LIMIT 1', row.user_id, row.counterpart_id, row.id))
      : (await get('SELECT * FROM reply_copy_receipts WHERE user_id=$1 AND counterpart_id=$2 AND suggestion_id=$3 AND copied_text=$4 ORDER BY copied_at DESC,_ordinal DESC LIMIT 1', row.user_id, row.counterpart_id, row.id, replyText));
    const matchingCopy = copy && (replyText === undefined || copy.copied_text === replyText) ? copy : null;
    const copyRestores = matchingCopy && laterSelf.every((message) => Date.parse(matchingCopy.copied_at) > Date.parse(message.updated_at));
    const superseded = laterSelf.length > 0 && !copyRestores;
    const manualSuperseded = superseded && laterSelf.some((message) => message.provenance !== 'inferred_from_followup' && (!matchingCopy || Date.parse(matchingCopy.copied_at) <= Date.parse(message.updated_at)));
    const activeCopy = superseded ? null : matchingCopy;
    const text = replyText ?? activeCopy?.copied_text ?? source.suggestion.reply;
    const consumed = (await consumedSource(row.user_id, row.counterpart_id, row.id, text, matchingCopy));
    const eligible = !superseded && !consumed;
    return { eligible, superseded, manualSuperseded, copy: eligible ? activeCopy : null, consumed,
      metadata: { pendingEligible: eligible, pendingCopyReceiptId: eligible ? activeCopy?.id ?? null : null, pendingCopiedAt: eligible ? activeCopy?.copied_at ?? null : null, pendingReplyText: eligible ? activeCopy?.copied_text ?? null : null } };
  };
  const suggestionValue = async (row) => {
    const source = (await suggestionSource(row));
    return { ...source.suggestion, ...(await pendingState(row, source)).metadata };
  };
  const styleRuleValue = (row) => ({ id: row.id, ...parse(row.value_json), status: row.status, source: 'user_self_report', sourceReviewId: row.source_review_id ?? null, supersedesId: row.supersedes_id ?? null, ruleHash: row.rule_hash, createdAt: row.created_at, adoptedAt: row.adopted_at ?? null, revokedAt: row.revoked_at ?? null });
  const styleRuleRow = async (userId, id) => { const row = (await get('SELECT * FROM style_rules WHERE id=$1 AND user_id=$2', id, userId)); if (!row) throw new BetaError('STYLE_RULE_NOT_FOUND', 404); return row; };
  const styleReplyObservation = async (userId, review) => {
    // Read-only decoration: linkage says a chat record exists, never that this
    // self expression was actually sent or that the observed response worked.
    const messageIds = (await all("SELECT received.id FROM messages received JOIN messages previous ON received.reply_to_message_id=previous.id WHERE received.user_id=$1 AND received.counterpart_id=$2 AND received.speaker='other' AND previous.user_id=$3 AND previous.counterpart_id=$4 AND previous.speaker='self' AND previous.suggestion_id=$5 AND previous.text=$6 ORDER BY received.seq", userId, review.counterpartId, userId, review.counterpartId, review.suggestionId, review.ownVersion)).map(({ id }) => id);
    return { status: messageIds.length ? 'recorded' : 'unknown', assessment: 'unassessed', messageIds };
  };
  const jobValue = (row) => row ? ({ id: row.id, userId: row.user_id, counterpartId: row.counterpart_id, operation: row.operation, requestId: row.request_id, contextHash: row.context_hash, knowledgeHash: row.knowledge_hash, state: row.state, result: parse(row.result_json), errorCode: row.error_code, createdAt: row.created_at, updatedAt: row.updated_at, workerId: row.worker_id, cacheOf: row.cache_of }) : null;
  const budget = async (subject, forDay) => { (await run('INSERT INTO provider_budget(subject,day) VALUES($1,$2) ON CONFLICT DO NOTHING', subject, forDay)); return (await get('SELECT * FROM provider_budget WHERE subject=$1 AND day=$2', subject, forDay)); };
  const providerLimit = (account) => account.plan === 'paid' ? paidProviderDailyLimit : freeProviderDailyLimit;
  const quota = async (userId) => {
    const account = (await user(userId));
    const currentDay = day();
    const local = (await budget(userId, currentDay)), global = (await budget('global', currentDay));
    return {
      classificationRemaining: account.plan === 'paid' ? null : Math.max(0, 3 - account.classification_used - account.classification_reserved),
      providerRemaining: Math.max(0, Math.min(providerLimit(account) - local.used - local.reserved, globalProviderDailyLimit - global.used - global.reserved)),
      providerDay: currentDay,
    };
  };
  async function releaseJob(row, code) {
    if (!row || !['reserved', 'running'].includes(row.state)) return;
    if (row.classification_reservation) (await run('UPDATE users SET classification_reserved=GREATEST(0,classification_reserved-1) WHERE id=$1', row.user_id));
    if (row.provider_reservation) {
      for (const subject of [row.user_id, 'global']) (await run('UPDATE provider_budget SET reserved=GREATEST(0,reserved-1) WHERE subject=$1 AND day=$2', subject, row.budget_day));
    }
    (await run("UPDATE model_jobs SET state='failed',error_code=$1,classification_reservation=0,provider_reservation=0,updated_at=$2 WHERE id=$3", code, timestamp(), row.id));
    (await run("UPDATE model_jobs SET state='failed',error_code=$1,updated_at=$2 WHERE cache_of=$3 AND state='linked'", code, timestamp(), row.id));
  }

  const recoverExpired = async () => {
    const rows = await all("SELECT * FROM model_jobs WHERE state IN ('reserved','running') AND lease_expires_at <= $1", now());
    for (const row of rows) {
      await releaseJob(row, 'JOB_INTERRUPTED');
      await audit(row.user_id, 'model_job_expired', row.id, { operation: row.operation });
    }
    return rows.length;
  };
  const store = {
    dataDir: null,
    close: async () => {},
    // Internal server composition only; no API or MCP operation exposes this row.
    // Nested calls use the existing scoped transaction instead of a second client.
    getCurrentKnowledgeVersion: async () => get(`SELECT version.hash,version.text,version.bytes,version.source_hash
      FROM chat_coach.knowledge_current current
      JOIN chat_coach.knowledge_versions version ON version.hash=current.hash
      WHERE current.singleton=TRUE`),
    getUser: async (id) => safeUser((await user(id))),
    // Startup helpers receive a safe view; no route exposes name-based lookup.
    getUserByUsername: async (username) => typeof username === 'string' ? safeUser((await get('SELECT * FROM users WHERE normalized_username=$1', username.normalize('NFC').trim().toLocaleLowerCase('en-US')))) : null,
    listUsers: async (ownerId) => { (await owner(ownerId)); return (await all('SELECT * FROM users ORDER BY created_at')).map(safeUser); },
    quota,
    async register({ invite, username, password }) {
      const checked = credentials(username, password);
      if (typeof invite !== 'string' || invite.length > 200) throw new BetaError('INVITE_INVALID');
      const passwordHash = await hashPassword(checked.password);
      return (await transaction(async () => {
        const invitation = (await get('SELECT * FROM invites WHERE token_hash=$1', digest(invite)));
        if (!invitation || invitation.used_by || invitation.expires_at <= now()) throw new BetaError('INVITE_INVALID');
        if ((await get('SELECT id FROM users WHERE normalized_username=$1', checked.normalized))) throw new BetaError('USERNAME_UNAVAILABLE', 409);
        const id = randomUUID(), createdAt = timestamp();
        (await run('INSERT INTO users(id,username,normalized_username,password_hash,plan,role,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', id, checked.username, checked.normalized, passwordHash, invitation.plan, 'user', createdAt, createdAt));
        (await run('UPDATE invites SET used_by=$1 WHERE token_hash=$2', id, digest(invite)));
        (await audit(id, 'account_registered', id, { plan: invitation.plan }));
        return safeUser((await user(id)));
      }));
    },
    async authenticate({ username, password }) {
      if (typeof username !== 'string' || typeof password !== 'string' || username.length > 40 || password.length > 128) throw new BetaError('LOGIN_FAILED', 401);
      const row = (await get('SELECT * FROM users WHERE normalized_username=$1', username.normalize('NFC').trim().toLocaleLowerCase('en-US')));
      if (!(await passwordMatches(password, row?.password_hash))) throw new BetaError('LOGIN_FAILED', 401);
      return safeUser(row);
    },
    async createSession(userId) {
      (await user(userId));
      const rawToken = token(), csrfToken = token(), expiresAt = now() + 7 * 86400_000;
      (await run('INSERT INTO sessions VALUES($1,$2,$3,$4)', digest(rawToken), userId, csrfToken, expiresAt));
      return { token: rawToken, csrfToken, expiresAt };
    },
    async lookupSession(rawToken) {
      if (typeof rawToken !== 'string' || rawToken.length > 200) return null;
      const row = (await get('SELECT sessions.*,users.username,users.plan,users.role FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=$1 AND expires_at>$2', digest(rawToken), now()));
      return row ? { user: { id: row.user_id, username: row.username, plan: row.plan, role: row.role }, csrfToken: row.csrf_token } : null;
    },
    removeSession: async (rawToken) => (await run('DELETE FROM sessions WHERE token_hash=$1', digest(rawToken))),
    async createInvite({ ownerId, plan, expiresInHours = 72 }) {
      (await owner(ownerId));
      if (!['free', 'paid'].includes(plan) || !Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > 720) throw new BetaError('INVITE_CONFIGURATION_INVALID');
      const invite = token();
      (await run('INSERT INTO invites VALUES($1,$2,$3,$4,$5,NULL)', digest(invite), plan, ownerId, timestamp(), now() + expiresInHours * 3600_000));
      (await audit(ownerId, 'invite_created', null, { plan, expiresInHours }));
      return { invite };
    },
    async updatePlan({ ownerId, userId, plan }) {
      (await owner(ownerId)); (await user(userId));
      if (!['free', 'paid'].includes(plan)) throw new BetaError('PLAN_INVALID');
      (await run('UPDATE users SET plan=$1,updated_at=$2 WHERE id=$3', plan, timestamp(), userId));
      (await audit(ownerId, 'plan_changed', userId, { plan }));
      return safeUser((await user(userId)));
    },
    async createMcpToken({ ownerId, userId }) {
      (await owner(ownerId)); (await user(userId));
      const rawToken = token(), expiresAt = now() + 30 * 86400_000;
      (await transaction(async () => {
        (await run('DELETE FROM mcp_tokens WHERE user_id=$1', userId));
        (await run('INSERT INTO mcp_tokens VALUES($1,$2,$3,$4,$5)', digest(rawToken), userId, ownerId, timestamp(), expiresAt));
        (await audit(ownerId, 'mcp_token_issued', userId, { expiresAt }));
      }));
      return { token: rawToken, expiresAt };
    },
    async lookupMcpToken(rawToken) {
      if (typeof rawToken !== 'string' || rawToken.length > 200) return null;
      const row = (await get('SELECT users.* FROM mcp_tokens JOIN users ON users.id=mcp_tokens.user_id WHERE token_hash=$1 AND expires_at>$2', digest(rawToken), now()));
      return safeUser(row);
    },
    async getProfile(userId) { (await user(userId)); const row = (await get('SELECT * FROM profiles WHERE user_id=$1', userId)); return row ? { ...parse(row.value_json), updatedAt: row.updated_at } : null; },
    async putProfile(userId, value) {
      (await user(userId));
      (await run('INSERT INTO profiles VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at', userId, json(value), timestamp()));
      (await run('UPDATE users SET style_revision=style_revision+1 WHERE id=$1', userId));
      (await audit(userId, 'profile_updated', userId, { questionnaireKind: value.questionnaire?.kind }));
      return (await this.getProfile(userId));
    },
    async getStyleLearning(userId) {
      const account = (await user(userId));
      const rules = (await all('SELECT * FROM style_rules WHERE user_id=$1 ORDER BY created_at,_ordinal', userId)).map(styleRuleValue);
      const reviews = await decorate(await all('SELECT * FROM style_reviews WHERE user_id=$1 ORDER BY created_at DESC,_ordinal DESC', userId), async (row) => {
        const record = parse(row.value_json);
        return { id: row.id, ...record, replyObservation: (await styleReplyObservation(userId, record)), createdAt: row.created_at };
      });
      return { revision: account.style_revision, activeRevision: account.active_style_revision, rules, reviews };
    },
    async getAppliedPersonalStyle(userId) {
      const account = (await user(userId));
      return appliedPersonalStyle((await all("SELECT * FROM style_rules WHERE user_id=$1 AND status='adopted' ORDER BY created_at,_ordinal", userId)).map(styleRuleValue), account.active_style_revision);
    },
    async saveProfileAndStyle(userId, value, styleInput) {
      const parsed = styleInput === undefined ? null : StyleLearningInputSchema.safeParse(styleInput);
      if (parsed && !parsed.success) throw new BetaError('INVALID_STYLE_LEARNING');
      const learning = parsed?.data;
      return (await transaction(async () => {
        const account = (await user(userId));
        const payloadHash = learning ? digest(json({ profile: value, styleLearning: learning })) : null;
        if (learning) {
          const receipt = (await get('SELECT * FROM style_save_receipts WHERE user_id=$1 AND request_id=$2', userId, learning.requestId));
          if (receipt) {
            if (receipt.payload_hash !== payloadHash) throw new BetaError('STYLE_REQUEST_CONFLICT', 409);
            return { profile: (await this.getProfile(userId)), styleLearning: { ...(await this.getStyleLearning(userId)), cached: true } };
          }
          if (account.style_revision !== learning.expectedRevision) throw new BetaError('STYLE_REVISION_CONFLICT', 409);
        }
        (await this.putProfile(userId, value));
        let reviewId = null, changedRuleId = null, activeChanged = false;
        if (learning?.review) {
          const input = learning.review;
          (await counterpartRow(userId, input.counterpartId));
          const source = (await this.getSuggestionCase(userId, input.counterpartId, input.suggestionId));
          const record = { ...input, source: 'user_self_report', version: STYLE_REVIEW_VERSION,
            originalSuggestion: { id: source.suggestion.id, reply: source.suggestion.reply, originJobId: source.originJobId, knowledgeHash: source.suggestion.knowledgeHash, contextStatus: source.status, snapshotHash: source.snapshotHash },
            replyObservation: (await styleReplyObservation(userId, input)) };
          reviewId = randomUUID();
          (await run('INSERT INTO style_reviews VALUES($1,$2,$3,$4,$5)', reviewId, userId, input.counterpartId, json(record), timestamp()));
          (await audit(userId, 'style_review_saved', reviewId, { suggestionId: input.suggestionId, reasonKind: input.reasonKind, source: 'user_self_report' }));
        }
        const change = learning?.ruleChange;
        if (change) {
          const activeCount = async () => (await get("SELECT COUNT(*) AS count FROM style_rules WHERE user_id=$1 AND status='adopted'", userId)).count;
          const assertCapacity = async (supersedes) => { if ((await activeCount()) - (supersedes?.status === 'adopted' ? 1 : 0) >= MAX_ACTIVE_STYLE_RULES) throw new BetaError('STYLE_ACTIVE_LIMIT'); };
          const revoke = async (row) => {
            if (row.status === 'revoked') return;
            (await run("UPDATE style_rules SET status='revoked',revoked_at=$1 WHERE id=$2", timestamp(), row.id));
            if (row.status === 'adopted') activeChanged = true;
            (await audit(userId, 'style_rule_revoked', row.id, { previousStatus: row.status }));
          };
          if (change.type === 'propose' || change.type === 'adopt_new') {
            const supersedes = change.supersedesId ? (await styleRuleRow(userId, change.supersedesId)) : null;
            const adopted = change.type === 'adopt_new';
            if (adopted && supersedes?.status === 'revoked') throw new BetaError('STYLE_RULE_STATE_INVALID', 409);
            if (adopted) (await assertCapacity(supersedes));
            changedRuleId = randomUUID();
            (await run('INSERT INTO style_rules VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL)', changedRuleId, userId, json(change.rule), adopted ? 'adopted' : 'candidate', reviewId, change.supersedesId ?? null, digest(json(change.rule)), timestamp(), adopted ? timestamp() : null));
            if (adopted) { if (supersedes) (await revoke(supersedes)); activeChanged = true; }
            (await audit(userId, adopted ? 'style_rule_adopted' : 'style_rule_proposed', changedRuleId, { target: change.rule.target, source: 'user_self_report', supersedesId: change.supersedesId ?? null }));
          } else if (change.type === 'adopt') {
            const candidate = (await styleRuleRow(userId, change.candidateId));
            if (candidate.status !== 'candidate') throw new BetaError('STYLE_RULE_STATE_INVALID', 409);
            const supersedes = candidate.supersedes_id ? (await styleRuleRow(userId, candidate.supersedes_id)) : null;
            if (supersedes?.status === 'revoked') throw new BetaError('STYLE_RULE_STATE_INVALID', 409);
            (await assertCapacity(supersedes));
            if (supersedes) (await revoke(supersedes));
            (await run("UPDATE style_rules SET status='adopted',adopted_at=$1 WHERE id=$2", timestamp(), candidate.id));
            changedRuleId = candidate.id; activeChanged = true;
            (await audit(userId, 'style_rule_adopted', candidate.id, { source: 'user_self_report', supersedesId: candidate.supersedes_id ?? null }));
          } else {
            const rule = (await styleRuleRow(userId, change.ruleId));
            (await revoke(rule)); changedRuleId = rule.id;
          }
        }
        if (activeChanged) (await run('UPDATE users SET active_style_revision=active_style_revision+1 WHERE id=$1', userId));
        if (learning) (await run('INSERT INTO style_save_receipts VALUES($1,$2,$3,$4,$5)', userId, learning.requestId, payloadHash, json({ reviewId, ruleId: changedRuleId }), timestamp()));
        return { profile: (await this.getProfile(userId)), styleLearning: { ...(await this.getStyleLearning(userId)), cached: false } };
      }));
    },
    async listCounterparts(userId) { (await user(userId)); return (await all('SELECT * FROM counterparts WHERE user_id=$1 ORDER BY updated_at DESC', userId)).map(counterpartValue); },
    getCounterpart: async (userId, id) => counterpartValue((await counterpartRow(userId, id))),
    async putCounterpart(userId, value, id) {
      (await user(userId));
      if (id) { (await counterpartRow(userId, id)); (await run('UPDATE counterparts SET value_json=$1,revision=revision+1,updated_at=$2 WHERE id=$3 AND user_id=$4', json(value), timestamp(), id, userId)); }
      else { id = randomUUID(); (await run('INSERT INTO counterparts VALUES($1,$2,$3,1,$4,$5)', id, userId, json(value), timestamp(), timestamp())); }
      (await audit(userId, 'counterpart_saved', id));
      return (await this.getCounterpart(userId, id));
    },
    async deleteCounterpart(userId, id) {
      (await counterpartRow(userId, id));
      (await transaction(async () => {
        for (const row of (await all("SELECT * FROM model_jobs WHERE user_id=$1 AND counterpart_id=$2 AND state IN ('reserved','running')", userId, id))) (await releaseJob(row, 'CONTEXT_DELETED'));
        (await run('DELETE FROM counterparts WHERE id=$1 AND user_id=$2', id, userId));
        (await audit(userId, 'counterpart_deleted', id));
      }));
    },
    async listMessages(userId, counterpartId) { (await counterpartRow(userId, counterpartId)); return decorate(await all('SELECT * FROM messages WHERE user_id=$1 AND counterpart_id=$2 ORDER BY seq', userId, counterpartId), messageValue); },
    async putMessage(userId, counterpartId, value, id) {
      (await counterpartRow(userId, counterpartId));
      return (await transaction(async () => {
        if (id) {
          const existing = (await get('SELECT * FROM messages WHERE id=$1 AND user_id=$2 AND counterpart_id=$3', id, userId, counterpartId));
          if (!existing) throw new BetaError('MESSAGE_NOT_FOUND', 404);
          (await run("UPDATE messages SET speaker=$1,text=$2,provenance=$3,updated_at=$4 WHERE id=$5", value.speaker, value.text, existing.provenance === 'inferred_from_followup' ? 'inferred_from_followup' : 'user_entered_edit', timestamp(), id));
          if (existing.speaker !== value.speaker) {
            (await run('UPDATE messages SET reply_to_message_id=NULL,reply_interval_json=NULL WHERE id=$1', id));
            (await run('UPDATE messages SET reply_to_message_id=NULL,reply_interval_json=NULL WHERE user_id=$1 AND counterpart_id=$2 AND reply_to_message_id=$3', userId, counterpartId, id));
          }
        } else {
          id = randomUUID();
          (await run('INSERT INTO messages(id,user_id,counterpart_id,speaker,text,suggestion_id,provenance,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', id, userId, counterpartId, value.speaker, value.text, value.suggestionId ?? null, value.suggestionId ? 'user_confirmed_record' : 'user_entered', timestamp(), timestamp()));
        }
        (await touch(counterpartId));
        (await audit(userId, 'message_saved', id, { speaker: value.speaker }));
        return (await messageValue((await get('SELECT * FROM messages WHERE id=$1', id))));
      }));
    },
    async deleteMessage(userId, counterpartId, id) {
      (await counterpartRow(userId, counterpartId));
      (await transaction(async () => {
        const removed = (await run('DELETE FROM messages WHERE id=$1 AND user_id=$2 AND counterpart_id=$3', id, userId, counterpartId));
        if (!removed.changes) throw new BetaError('MESSAGE_NOT_FOUND', 404);
        (await run('UPDATE messages SET reply_to_message_id=NULL,reply_interval_json=NULL WHERE user_id=$1 AND counterpart_id=$2 AND reply_to_message_id=$3', userId, counterpartId, id));
        (await touch(counterpartId)); (await audit(userId, 'message_deleted', id));
      }));
    },
    async putMessageTime(userId, counterpartId, id, actualWechatAt) {
      (await counterpartRow(userId, counterpartId));
      const at = actualWechatAt === null ? null : new Date(actualWechatAt).toISOString();
      if (at && Date.parse(at) > now()) throw new BetaError('MESSAGE_TIME_INVALID');
      return (await transaction(async () => {
        const row = (await get('SELECT * FROM messages WHERE id=$1 AND user_id=$2 AND counterpart_id=$3', id, userId, counterpartId));
        if (!row) throw new BetaError('MESSAGE_NOT_FOUND', 404);
        const prior = parse(row.wechat_time_json);
        if ((prior?.at ?? null) !== at) {
          const recorded = at ? { at, source: 'user_reported', editedAt: timestamp() } : null;
          (await run('UPDATE messages SET wechat_time_json=$1,updated_at=$2 WHERE id=$3', recorded ? json(recorded) : null, timestamp(), id));
          (await touch(counterpartId)); (await audit(userId, 'message_time_reported', id, { source: 'user_reported', removed: at === null }));
        }
        return (await messageValue((await get('SELECT * FROM messages WHERE id=$1', id))));
      }));
    },
    async getMeeting(userId, counterpartId) { (await counterpartRow(userId, counterpartId)); const row = (await get('SELECT * FROM meetings WHERE user_id=$1 AND counterpart_id=$2', userId, counterpartId)); return row ? parse(row.value_json) : { status: 'none', time: '', place: '', note: '' }; },
    async putMeeting(userId, counterpartId, value) {
      (await counterpartRow(userId, counterpartId));
      (await run('INSERT INTO meetings VALUES($1,$2,$3,$4) ON CONFLICT(counterpart_id) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at', counterpartId, userId, json(value), timestamp()));
      (await audit(userId, 'meeting_saved', counterpartId, { status: value.status }));
      return value;
    },
    async listSuggestions(userId, counterpartId) { (await counterpartRow(userId, counterpartId)); return decorate(await all('SELECT * FROM suggestions WHERE user_id=$1 AND counterpart_id=$2 ORDER BY created_at', userId, counterpartId), suggestionValue); },
    async getSuggestion(userId, counterpartId, id) { (await counterpartRow(userId, counterpartId)); const row = (await get('SELECT * FROM suggestions WHERE id=$1 AND user_id=$2 AND counterpart_id=$3', id, userId, counterpartId)); if (!row) throw new BetaError('SUGGESTION_NOT_FOUND', 404); return (await suggestionValue(row)); },
    async getSuggestionCase(userId, counterpartId, id) {
      (await counterpartRow(userId, counterpartId));
      const row = (await get('SELECT * FROM suggestions WHERE id=$1 AND user_id=$2 AND counterpart_id=$3', id, userId, counterpartId));
      if (!row) throw new BetaError('SUGGESTION_NOT_FOUND', 404);
      const source = (await suggestionSource(row));
      return { ...source, suggestion: { ...source.suggestion, ...(await pendingState(row, source)).metadata } };
    },
    async recordReplyCopy(userId, counterpartId, suggestionId, { copiedText, requestId }) {
      (await counterpartRow(userId, counterpartId));
      return (await transaction(async () => {
        const source = (await this.getSuggestionCase(userId, counterpartId, suggestionId));
        if (['wait', 'pause'].includes(source.suggestion.action)) throw new BetaError('SUGGESTION_NOT_SENDABLE', 409);
        const text = copiedText ?? source.suggestion.reply;
        const payloadHash = digest(json({ counterpartId, suggestionId, text }));
        const existing = (await get('SELECT * FROM reply_copy_receipts WHERE user_id=$1 AND request_id=$2', userId, requestId));
        if (existing) {
          if (existing.payload_hash !== payloadHash) throw new BetaError('COPY_REQUEST_CONFLICT', 409);
          return { copyReceipt: { id: existing.id, suggestionId, copiedAt: existing.copied_at, provenance: 'clipboard_copied' }, cached: true };
        }
        const id = randomUUID(), copiedAt = timestamp();
        (await run('INSERT INTO reply_copy_receipts VALUES($1,$2,$3,$4,$5,$6,$7,$8)', id, userId, counterpartId, suggestionId, requestId, payloadHash, text, copiedAt));
        (await audit(userId, 'reply_copy_reported', id, { suggestionId, provenance: 'clipboard_copied', sendingVerified: false }));
        return { copyReceipt: { id, suggestionId, copiedAt, provenance: 'clipboard_copied' }, cached: false };
      }));
    },
    async recordFollowup(userId, counterpartId, { text, previousSuggestionId, previousReplyText, previousCopyReceiptId, requestId }) {
      (await counterpartRow(userId, counterpartId));
      return (await transaction(async () => {
        const payloadHash = digest(json({ counterpartId, text, previousSuggestionId: previousSuggestionId ?? null, previousReplyText: previousReplyText ?? null, previousCopyReceiptId: previousCopyReceiptId ?? null }));
        const prior = (await get('SELECT * FROM followup_receipts WHERE user_id=$1 AND request_id=$2', userId, requestId));
        if (prior) {
          if (prior.payload_hash !== payloadHash) throw new BetaError('FOLLOWUP_REQUEST_CONFLICT', 409);
          return { ...parse(prior.result_json), cached: true };
        }
        let source = previousSuggestionId ? (await this.getSuggestionCase(userId, counterpartId, previousSuggestionId)) : null;
        // Older clients may attach their editable text to a pacing suggestion.
        // Preserve the incoming message without inventing a preceding self turn.
        const noReply = ['wait', 'pause'].includes(source?.suggestion.action);
        let associatedSuggestionId = noReply ? undefined : previousSuggestionId, associatedReplyText = noReply ? undefined : previousReplyText;
        if (noReply) source = null;
        let copy;
        if (!noReply && previousCopyReceiptId) {
          copy = (await get('SELECT * FROM reply_copy_receipts WHERE id=$1 AND user_id=$2 AND counterpart_id=$3', previousCopyReceiptId, userId, counterpartId));
          if (!copy || copy.suggestion_id !== previousSuggestionId) throw new BetaError('COPY_RECEIPT_NOT_FOUND', 404);
          if (copy.copied_text !== previousReplyText) copy = null;
        } else if (source && previousReplyText) copy = (await get('SELECT * FROM reply_copy_receipts WHERE user_id=$1 AND counterpart_id=$2 AND suggestion_id=$3 AND copied_text=$4 ORDER BY copied_at DESC,_ordinal DESC LIMIT 1', userId, counterpartId, previousSuggestionId, previousReplyText));
        if (source) {
          const row = (await get('SELECT * FROM suggestions WHERE id=$1 AND user_id=$2 AND counterpart_id=$3', previousSuggestionId, userId, counterpartId));
          const state = (await pendingState(row, source, { replyText: previousReplyText, copy }));
          if (state.consumed && !state.manualSuperseded) {
            if (state.consumed.counterpart_text_hash !== digest(text)) throw new BetaError('FOLLOWUP_SOURCE_ALREADY_LINKED', 409);
            const result = parse(state.consumed.result_json);
            (await run('INSERT INTO followup_receipts(id,user_id,counterpart_id,request_id,payload_hash,result_json,created_at,previous_suggestion_id,previous_reply_hash,counterpart_text_hash,copy_receipt_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', randomUUID(), userId, counterpartId, requestId, payloadHash, state.consumed.result_json, timestamp(), previousSuggestionId, digest(previousReplyText), digest(text), state.consumed.copy_receipt_id ?? null));
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
        const insertMessage = async (speaker, content, suggestionId, provenance, interval) => {
          const id = randomUUID();
          (await run('INSERT INTO messages(id,user_id,counterpart_id,speaker,text,suggestion_id,provenance,created_at,updated_at,reply_interval_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', id, userId, counterpartId, speaker, content, suggestionId ?? null, provenance, createdAt, createdAt, interval ? json(interval) : null));
          return (await messageValue((await get('SELECT * FROM messages WHERE id=$1', id))));
        };
        const lastRecorded = (await get('SELECT id,speaker FROM messages WHERE user_id=$1 AND counterpart_id=$2 ORDER BY seq DESC LIMIT 1', userId, counterpartId));
        const previousMessage = associatedReplyText ? (await insertMessage('self', associatedReplyText, associatedSuggestionId, 'inferred_from_followup', null)) : null;
        const message = (await insertMessage('other', text, null, 'user_entered', timing));
        const linkedSelf = previousMessage?.id ?? (lastRecorded?.speaker === 'self' ? lastRecorded.id : null);
        if (linkedSelf) (await run('UPDATE messages SET reply_to_message_id=$1 WHERE id=$2', linkedSelf, message.id));
        let feedback = null;
        if (previousMessage) {
          const id = randomUUID();
          const envelope = { id, createdAt, sourceMode: 'beta_followup', sourceAccountId: userId, stage: 'raw_untrusted', outcome: 'unknown', consent: false, automaticPromotionAllowed: false,
            payload: { suggestionId: associatedSuggestionId ?? '', actualSentText: associatedReplyText, counterpartReply: text, observation: '', kind: 'uncertain', consent: false },
            caseEvidence: { originJobId: source?.originJobId ?? null, contextStatus: source?.status ?? 'legacy_incomplete', suggestionId: associatedSuggestionId ?? null, previousMessage, counterpartMessage: message, timing, copyReceiptId: copy?.id ?? null, actualSend: 'inferred_from_followup', outcomeSource: 'user_reported' } };
          (await run('INSERT INTO feedback VALUES($1,$2,$3,$4,$5,NULL,NULL,$6,$7)', id, userId, counterpartId, 'raw_untrusted', json(envelope), createdAt, createdAt));
          feedback = { id, stage: 'raw_untrusted' };
          (await audit(userId, 'followup_feedback_received', id, { stage: 'raw_untrusted', consent: false, actualSend: 'inferred_from_followup', outcome: 'unknown' }));
        }
        (await touch(counterpartId));
        const result = { message, previousMessage, feedback, timing };
        (await run('INSERT INTO followup_receipts(id,user_id,counterpart_id,request_id,payload_hash,result_json,created_at,previous_suggestion_id,previous_reply_hash,counterpart_text_hash,copy_receipt_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', randomUUID(), userId, counterpartId, requestId, payloadHash, json(result), createdAt, associatedSuggestionId ?? null, associatedReplyText ? digest(associatedReplyText) : null, digest(text), copy?.id ?? null));
        (await audit(userId, 'followup_recorded', message.id, { previousSuggestionId: associatedSuggestionId ?? null, ignoredSuggestionId: previousSuggestionId && !associatedSuggestionId ? previousSuggestionId : null, inferredPreviousReply: Boolean(previousMessage) }));
        return { ...result, cached: false };
      }));
    },
    async findSentMessage(userId, counterpartId, suggestionId, actualSentText) { (await counterpartRow(userId, counterpartId)); return (await messageValue((await get("SELECT * FROM messages WHERE user_id=$1 AND counterpart_id=$2 AND suggestion_id=$3 AND speaker='self' AND text=$4 AND provenance='user_confirmed_record' ORDER BY seq DESC LIMIT 1", userId, counterpartId, suggestionId, actualSentText)))); },
    async latestSuccessful(userId, counterpartId, operation, contextHash) { (await counterpartRow(userId, counterpartId)); return jobValue((await get("SELECT * FROM model_jobs WHERE user_id=$1 AND counterpart_id=$2 AND operation=$3 AND context_hash=$4 AND state='succeeded' ORDER BY updated_at DESC LIMIT 1", userId, counterpartId, operation, contextHash))); },
    async hasModelAttempt(userId, counterpartId, operation, contextHash) { (await counterpartRow(userId, counterpartId)); return Boolean((await get('SELECT id FROM model_jobs WHERE user_id=$1 AND counterpart_id=$2 AND operation=$3 AND context_hash=$4 LIMIT 1', userId, counterpartId, operation, contextHash))); },
    async latestCoachPlan(userId, counterpartId, baseContextHash) {
      (await counterpartRow(userId, counterpartId));
      const row = (await get("SELECT * FROM model_jobs WHERE user_id=$1 AND counterpart_id=$2 AND operation='coach_plan' AND state='succeeded' AND cache_of IS NULL AND (context_snapshot_json::jsonb ->> 'baseContextHash')=$3 ORDER BY updated_at DESC,_ordinal DESC LIMIT 1", userId, counterpartId, baseContextHash));
      if (!row) return null;
      return { plan: parse(row.context_snapshot_json).request.plan, planAssessment: parse(row.result_json).planAssessment };
    },
    async listJobs(userId, counterpartId) { (await counterpartRow(userId, counterpartId)); return (await all('SELECT * FROM model_jobs WHERE user_id=$1 AND counterpart_id=$2 ORDER BY created_at DESC LIMIT 30', userId, counterpartId)).map(jobValue); },
    async previousClassification(userId, counterpartId) { (await counterpartRow(userId, counterpartId)); return jobValue((await get("SELECT * FROM model_jobs WHERE user_id=$1 AND counterpart_id=$2 AND operation='classify' AND state='succeeded' AND cache_of IS NULL ORDER BY updated_at DESC LIMIT 1", userId, counterpartId))); },
    async reserveJob({ userId, counterpartId, operation, requestId, contextHash, knowledgeHash, workerId, providerModel, contextSnapshot }) {
      await recoverExpired();
      (await counterpartRow(userId, counterpartId));
      return (await transaction(async () => {
        const existing = (await get('SELECT * FROM model_jobs WHERE user_id=$1 AND operation=$2 AND request_id=$3', userId, operation, requestId));
        if (existing) {
          if (existing.context_hash !== contextHash || existing.counterpart_id !== counterpartId) throw new BetaError('REQUEST_ID_CONTEXT_CONFLICT', 409);
          if (existing.state === 'linked') return { job: jobValue((await get('SELECT * FROM model_jobs WHERE id=$1', existing.cache_of))), cached: true, fresh: false };
          return { job: jobValue(existing), cached: existing.state === 'succeeded', fresh: false };
        }
        const cached = (await get("SELECT * FROM model_jobs WHERE user_id=$1 AND counterpart_id=$2 AND operation=$3 AND context_hash=$4 AND state='succeeded' ORDER BY updated_at DESC LIMIT 1", userId, counterpartId, operation, contextHash));
        const id = randomUUID(), createdAt = timestamp(), currentDay = day();
        if (cached) {
          (await run('INSERT INTO model_jobs(id,user_id,counterpart_id,operation,request_id,context_hash,knowledge_hash,state,result_json,budget_day,worker_id,provider_model,cache_of,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)', id, userId, counterpartId, operation, requestId, contextHash, knowledgeHash, 'succeeded', cached.result_json, currentDay, workerId, providerModel, cached.id, createdAt, createdAt));
          (await audit(userId, 'model_job_replayed', id, { operation, cacheOf: cached.id }));
          return { job: jobValue((await get('SELECT * FROM model_jobs WHERE id=$1', id))), cached: true, fresh: false };
        }
        const pending = (await get("SELECT * FROM model_jobs WHERE user_id=$1 AND counterpart_id=$2 AND operation=$3 AND context_hash=$4 AND state IN ('reserved','running') LIMIT 1", userId, counterpartId, operation, contextHash));
        if (pending) {
          (await run('INSERT INTO model_jobs(id,user_id,counterpart_id,operation,request_id,context_hash,knowledge_hash,state,budget_day,worker_id,provider_model,cache_of,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)', id, userId, counterpartId, operation, requestId, contextHash, knowledgeHash, 'linked', currentDay, workerId, providerModel, pending.id, createdAt, createdAt));
          return { job: jobValue(pending), cached: true, fresh: false };
        }
        const account = (await user(userId)), classReservation = operation === 'classify' && account.plan === 'free' ? 1 : 0;
        if (classReservation && account.classification_used + account.classification_reserved >= 3) throw new BetaError('CLASSIFICATION_QUOTA_EXHAUSTED', 402);
        const local = (await budget(userId, currentDay)), global = (await budget('global', currentDay));
        if (local.used + local.reserved >= providerLimit(account) || global.used + global.reserved >= globalProviderDailyLimit) throw new BetaError('PROVIDER_BUDGET_EXHAUSTED', 429);
        if (classReservation) (await run('UPDATE users SET classification_reserved=classification_reserved+1 WHERE id=$1', userId));
        for (const subject of [userId, 'global']) (await run('UPDATE provider_budget SET reserved=reserved+1 WHERE subject=$1 AND day=$2', subject, currentDay));
        const snapshotJson = contextSnapshot ? json(contextSnapshot) : null;
        (await run('INSERT INTO model_jobs(id,user_id,counterpart_id,operation,request_id,context_hash,knowledge_hash,state,classification_reservation,provider_reservation,budget_day,worker_id,provider_model,created_at,updated_at,context_snapshot_json,snapshot_hash,lease_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)', id, userId, counterpartId, operation, requestId, contextHash, knowledgeHash, 'reserved', classReservation, 1, currentDay, workerId, providerModel, createdAt, createdAt, snapshotJson, snapshotJson ? digest(snapshotJson) : null, now() + leaseMs));
        (await audit(userId, 'model_job_reserved', id, { operation, knowledgeHash, contextHash }));
        return { job: jobValue((await get('SELECT * FROM model_jobs WHERE id=$1', id))), fresh: true, cached: false };
      }));
    },
    async markJobRunning(id) {
      return (await transaction(async () => {
        const row = (await get('SELECT * FROM model_jobs WHERE id=$1', id));
        if (!row || row.state !== 'reserved') throw new BetaError('JOB_NOT_AVAILABLE', 409);
        if (Number(row.lease_expires_at) <= now()) throw new BetaError('JOB_INTERRUPTED', 409);
        for (const subject of [row.user_id, 'global']) (await run('UPDATE provider_budget SET reserved=GREATEST(0,reserved-1),used=used+1 WHERE subject=$1 AND day=$2', subject, row.budget_day));
        (await run("UPDATE model_jobs SET state='running',provider_reservation=0,updated_at=$1,lease_expires_at=$2 WHERE id=$3", timestamp(), now() + leaseMs, id));
      }));
    },
    async completeJob(id, result, suggestion) {
      return (await transaction(async () => {
        const row = (await get('SELECT * FROM model_jobs WHERE id=$1', id));
        if (!row || row.state !== 'running') throw new BetaError('JOB_NOT_AVAILABLE', 409);
        if (Number(row.lease_expires_at) <= now()) throw new BetaError('JOB_INTERRUPTED', 409);
        if (row.classification_reservation) (await run('UPDATE users SET classification_reserved=GREATEST(0,classification_reserved-1),classification_used=classification_used+1 WHERE id=$1', row.user_id));
        if (suggestion) (await run('INSERT INTO suggestions(id,user_id,counterpart_id,value_json,context_hash,knowledge_hash,created_at,origin_job_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', suggestion.id, row.user_id, row.counterpart_id, json(suggestion), row.context_hash, row.knowledge_hash, timestamp(), id));
        (await run("UPDATE model_jobs SET state='succeeded',result_json=$1,classification_reservation=0,updated_at=$2 WHERE id=$3", json(result), timestamp(), id));
        (await run("UPDATE model_jobs SET state='succeeded',result_json=$1,updated_at=$2 WHERE cache_of=$3 AND state='linked'", json(result), timestamp(), id));
        (await audit(row.user_id, 'model_job_completed', id, { operation: row.operation, knowledgeHash: row.knowledge_hash }));
        return jobValue((await get('SELECT * FROM model_jobs WHERE id=$1', id)));
      }));
    },
    async failJob(id, code, { diagnostics } = {}) { (await transaction(async () => { const row = (await get('SELECT * FROM model_jobs WHERE id=$1', id)); (await releaseJob(row, code)); if (row) (await audit(row.user_id, 'model_job_failed', id, { code, ...(diagnostics === undefined ? {} : { diagnostics }) })); })); },
    async recoverExpiredJobs() { return recoverExpired(); },
    async recoverAbandonedJobs() { return recoverExpired(); },
    async takeRateLimit({ key, limit, windowMs = 60_000 }) {
      if (typeof key !== 'string' || !key.length || key.length > 512 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10_000 || !Number.isSafeInteger(windowMs) || windowMs < 1 || windowMs > 86_400_000) throw new BetaError('RATE_LIMIT_CONFIGURATION_INVALID');
      const clock = now();
      await run('DELETE FROM rate_limits WHERE reset_at <= $1', clock);
      let row = await get('SELECT * FROM rate_limits WHERE key=$1', key);
      if (!row) {
        await run('INSERT INTO rate_limits(key,count,reset_at) VALUES($1,1,$2)', key, clock + windowMs);
        row = { count: 1, reset_at: clock + windowMs };
      } else {
        row.count = Math.min(limit + 1, row.count + 1);
        await run('UPDATE rate_limits SET count=$1 WHERE key=$2', row.count, key);
      }
      return { allowed: row.count <= limit, remaining: Math.max(0, limit - row.count), resetAt: Number(row.reset_at) };
    },
    async addFeedback(userId, counterpartId, raw) {
      (await counterpartRow(userId, counterpartId));
      const id = randomUUID(), createdAt = timestamp();
      const source = (await this.getSuggestionCase(userId, counterpartId, raw.suggestionId));
      const sent = (await this.findSentMessage(userId, counterpartId, raw.suggestionId, raw.actualSentText));
      const envelope = { id, createdAt, sourceMode: 'beta_account', sourceAccountId: userId, stage: 'raw_untrusted', payload: raw,
        caseEvidence: { originJobId: source.originJobId, contextStatus: source.status, suggestionId: raw.suggestionId, previousMessage: sent, counterpartReply: raw.counterpartReply, actualSend: sent ? 'user_confirmed_record' : 'unconfirmed', outcomeSource: 'user_reported' } };
      (await run('INSERT INTO feedback VALUES($1,$2,$3,$4,$5,NULL,NULL,$6,$7)', id, userId, counterpartId, 'raw_untrusted', json(envelope), createdAt, createdAt));
      (await audit(userId, 'feedback_received', id, { stage: 'raw_untrusted' }));
      return { id, stage: 'raw_untrusted' };
    },
    async getFeedback(ownerId, id) {
      (await owner(ownerId));
      const row = (await get('SELECT feedback.*,users.username FROM feedback JOIN users ON users.id=feedback.user_id WHERE feedback.id=$1', id));
      if (!row) throw new BetaError('FEEDBACK_NOT_FOUND', 404);
      const raw = parse(row.raw_json);
      const sourceId = raw.caseEvidence?.originJobId;
      const job = sourceId ? (await get('SELECT * FROM model_jobs WHERE id=$1 AND user_id=$2 AND counterpart_id=$3', sourceId, row.user_id, row.counterpart_id)) : null;
      const caseEvidence = { ...(raw.caseEvidence ?? {}), contextStatus: job?.context_snapshot_json ? 'complete' : 'legacy_incomplete', snapshot: parse(job?.context_snapshot_json), snapshotHash: job?.snapshot_hash ?? null };
      return { id: row.id, counterpartId: row.counterpart_id, user: { id: row.user_id, username: row.username }, stage: row.stage, raw, caseEvidence, cleaning: parse(row.cleaning_json), review: parse(row.review_json), createdAt: row.created_at };
    },
    async listFeedback(ownerId) { (await owner(ownerId)); return decorate(await all('SELECT id FROM feedback ORDER BY created_at DESC LIMIT 500'), (row) => this.getFeedback(ownerId, row.id)); },
    async saveCleaning(ownerId, id, candidate) {
      (await owner(ownerId)); const current = (await this.getFeedback(ownerId, id));
      if (current.review || (await get('SELECT feedback_id FROM knowledge_approvals WHERE feedback_id=$1', id))) throw new BetaError('FEEDBACK_ALREADY_REVIEWED', 409);
      const duplicate = (await all('SELECT id,cleaning_json FROM feedback WHERE id<>$1 AND cleaning_json IS NOT NULL', id)).find((row) => parse(row.cleaning_json)?.dedupKey === candidate.dedupKey);
      if (duplicate) candidate = { ...candidate, stage: 'quarantined', flags: [...(candidate.flags ?? []), 'duplicate_submission'], duplicateOf: duplicate.id, allowedPurposes: [] };
      (await run('UPDATE feedback SET stage=$1,cleaning_json=$2,updated_at=$3 WHERE id=$4', candidate.stage, json(candidate), timestamp(), id));
      (await audit(ownerId, 'feedback_cleaned', id, { stage: candidate.stage, transformations: candidate.transformations?.length ?? 0 }));
      return (await this.getFeedback(ownerId, id));
    },
    async saveReview(ownerId, id, receipt) {
      (await owner(ownerId)); const existing = (await this.getFeedback(ownerId, id));
      if (existing.review) return existing;
      return (await transaction(async () => {
        const reviewed = { ...receipt, reviewerId: ownerId, reviewedAt: timestamp() };
        (await run('UPDATE feedback SET stage=$1,review_json=$2,updated_at=$3 WHERE id=$4', receipt.stage, json(reviewed), timestamp(), id));
        (await run('INSERT INTO feedback_reviews VALUES($1,$2,$3,$4,$5)', randomUUID(), id, ownerId, json(reviewed), timestamp()));
        (await audit(ownerId, 'feedback_reviewed', id, { stage: receipt.stage, purpose: receipt.purpose ?? null }));
        return (await this.getFeedback(ownerId, id));
      }));
    },
    async beginKnowledgeApproval(ownerId, id, reviewHash, receipt, supplement) {
      (await owner(ownerId));
      return (await transaction(async () => {
        const existing = (await get('SELECT * FROM knowledge_approvals WHERE feedback_id=$1', id));
        if (existing) { if (existing.review_hash !== reviewHash) throw new BetaError('REVIEW_CONFLICT', 409); return existing; }
        const marker = `<!-- FEEDBACK_APPROVAL:${id} -->`;
        (await run('INSERT INTO knowledge_approvals VALUES($1,$2,$3,$4,$5,$6,NULL,$7,$8)', id, reviewHash, marker, supplement, json(receipt), 'pending', timestamp(), timestamp()));
        return (await get('SELECT * FROM knowledge_approvals WHERE feedback_id=$1', id));
      }));
    },
    async getKnowledgeApproval(ownerId, id) { (await owner(ownerId)); return (await get('SELECT * FROM knowledge_approvals WHERE feedback_id=$1', id)) ?? null; },
    async finishKnowledgeApproval(ownerId, id, knowledgeHash) {
      (await owner(ownerId));
      return (await transaction(async () => {
        const approval = (await get('SELECT * FROM knowledge_approvals WHERE feedback_id=$1', id));
        if (!approval) throw new BetaError('APPROVAL_NOT_FOUND', 404);
        if (approval.state === 'committed') return (await this.getFeedback(ownerId, id));
        (await run("UPDATE knowledge_approvals SET state='committed',knowledge_hash=$1,updated_at=$2 WHERE feedback_id=$3", knowledgeHash, timestamp(), id));
        const receipt = { ...parse(approval.review_json), reviewerId: ownerId, reviewedAt: timestamp(), approvalReceipt: id, knowledgeHash };
        (await run('UPDATE feedback SET stage=$1,review_json=$2,updated_at=$3 WHERE id=$4', receipt.stage, json(receipt), timestamp(), id));
        (await run('INSERT INTO feedback_reviews VALUES($1,$2,$3,$4,$5)', randomUUID(), id, ownerId, json(receipt), timestamp()));
        (await audit(ownerId, 'knowledge_supplement_approved', id, { knowledgeHash }));
        return (await this.getFeedback(ownerId, id));
      }));
    },
    async seedOwner({ username, password }) {
      const checked = credentials(username, password), passwordHash = await hashPassword(password);
      return (await transaction(async () => {
        const existing = (await get('SELECT * FROM users WHERE normalized_username=$1', checked.normalized));
        if (existing) {
          if (existing.role !== 'owner') throw new BetaError('OWNER_USERNAME_CONFLICT', 409);
          throw new BetaError('OWNER_ALREADY_EXISTS', 409);
        }
        const id = randomUUID(), createdAt = timestamp();
        (await run('INSERT INTO users(id,username,normalized_username,password_hash,plan,role,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', id, checked.username, checked.normalized, passwordHash, 'paid', 'owner', createdAt, createdAt));
        (await audit(id, 'owner_seeded', id));
        return safeUser((await user(id)));
      }));
    },
  };
  const readMethods = new Set(['getCurrentKnowledgeVersion', 'getUser', 'getUserByUsername', 'listUsers', 'authenticate', 'lookupSession', 'lookupMcpToken', 'getProfile', 'getStyleLearning', 'getAppliedPersonalStyle', 'listCounterparts', 'getCounterpart', 'listMessages', 'getMeeting', 'listSuggestions', 'getSuggestion', 'getSuggestionCase', 'findSentMessage', 'latestSuccessful', 'hasModelAttempt', 'latestCoachPlan', 'listJobs', 'previousClassification', 'getFeedback', 'listFeedback', 'getKnowledgeApproval']);
  const facade = { dataDir: null, close: async () => {} };
  for (const [name, method] of Object.entries(store)) {
    if (typeof method !== 'function' || name === 'close') continue;
    facade[name] = (...args) => transaction(() => method.apply(facade, args), { readOnly: readMethods.has(name) });
  }
  // Compose related API reads/writes without exposing a database client. Both
  // helpers reuse this store's async transaction scope for nested method calls.
  facade.withSnapshot = (callback) => transaction(() => callback(facade), { readOnly: true });
  facade.withTransaction = (callback) => transaction(() => callback(facade));
  return facade;
}
