import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, open, unlink, stat, mkdir } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import packageMetadata from '../package.json' with { type: 'json' };
import { BetaError } from './store-contract.mjs';
import { createKnowledgeStore, guardRestrictedOutput, PROJECT_ROOT } from './knowledge.mjs';
import { COACH_CONTEXT_VERSION, COACH_PROTOCOL_VERSION } from './chat-record.mjs';
import { StyleLearningInputSchema } from './style-learning.mjs';
import { generateFieldCoachPlan } from './field-coach.mjs';
import { classifyChat, generateReply } from './coach.mjs';
import { interpretChatImage, validateChatImage, guardImageBytes, validateImageInterpretation, IMAGE_BODY_LIMIT, IMAGE_INPUT_VERSION } from './image-input.mjs';
import {
  QUESTIONNAIRES, validateProfile, buildChatContext, computeHeat, rankTopThree,
  ProfileInputSchema, CounterpartInputSchema, MeetingInputSchema, FeedbackInputSchema, ReviewInputSchema,
  cleanFeedback, reviewFeedback, buildFeedbackKnowledgeSupplement,
} from './domain.mjs';

export { BetaError };
export async function seedOwner(store, options) { return await store.seedOwner(options); }
const digest = (value) => createHash('sha256').update(value).digest('hex');
const AUTH_COOKIE = 'chat_coach_session';
const BODY_LIMIT = 256_000;
const JsonObject = z.record(z.string(), z.unknown());
const RegisterSchema = z.strictObject({ invite: z.string().min(1).max(200), username: z.string(), password: z.string() });
const LoginSchema = z.strictObject({ username: z.string(), password: z.string() });
const RequestId = z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/);
const ClassifySchema = z.strictObject({ requestId: RequestId });
const ImageReadSchema = z.strictObject({ requestId: RequestId, image: z.string(), explanation: z.string().trim().max(2_000).default('') });
const ReplySchema = z.strictObject({ requestId: RequestId, direction: z.enum(['up', 'down', 'sideways']).optional(), intent: z.string().trim().max(2_000).optional() });
const PlanInputSchema = z.strictObject({ requestId: RequestId, plan: z.string().trim().min(1).max(2_000) });
const MessageSchema = z.strictObject({ speaker: z.enum(['self', 'other']), text: z.string().trim().min(1).max(20_000) });
const SentSchema = z.strictObject({ suggestionId: z.string().min(1).max(128), actualSentText: z.string().trim().min(1).max(20_000) });
const FollowupSchema = z.strictObject({ text: z.string().trim().min(1).max(20_000), requestId: RequestId, previousSuggestionId: z.string().min(1).max(128).optional(), previousReplyText: z.string().trim().min(1).max(20_000).optional(), previousCopyReceiptId: z.string().min(1).max(128).optional() })
  .refine((input) => (!input.previousSuggestionId || input.previousReplyText) && (!input.previousCopyReceiptId || input.previousSuggestionId), { message: 'Previous source requires a draft.' });
const CopySchema = z.strictObject({ copiedText: z.string().trim().min(1).max(20_000).optional(), requestId: RequestId });
const MessageTimeSchema = z.strictObject({ actualWechatAt: z.iso.datetime({ offset: true }).nullable() });
const PlanSchema = z.strictObject({ plan: z.enum(['free', 'paid']) });
const ProfileSaveSchema = ProfileInputSchema.extend({ styleLearning: StyleLearningInputSchema.optional() });

const MESSAGES = {
  UNAUTHORIZED: '请先登录。', CSRF_INVALID: '会话校验未通过，请刷新页面。', ORIGIN_FORBIDDEN: '请求来源不匹配。',
  OWNER_REQUIRED: '此操作仅限项目 owner。', CLASSIFICATION_QUOTA_EXHAUSTED: '三次分类试用已用完，可以继续直接生成回复。',
  PROVIDER_BUDGET_EXHAUSTED: '今日模型调用预算已用完。', PROFILE_REQUIRED: '请先完成个人背景和问卷。',
  FULL_QUESTIONNAIRE_PAID_ONLY: '完整版问卷仅向付费测试账户开放。', FULL_PROFILE_REQUIRES_UPDATE: '请保存短版问卷后继续。',
  REQUEST_ID_CONTEXT_CONFLICT: '请求编号已用于其他上下文，请创建新请求。', CONTEXT_CHANGED: '聊天背景已更新，请使用新请求重新生成。',
  JOB_IN_PROGRESS: '这次请求仍在处理中。', JOB_INTERRUPTED: '上次请求被中断，请使用新请求重试。',
  LOGIN_FAILED: '账号或密码不匹配。', INVITE_INVALID: '邀请码无效、已使用或已过期。', PASSWORD_INVALID: '密码需为10至128字符，并包含字母和数字。',
  USERNAME_INVALID: '用户名需为2至40字符，可用中文、字母、数字、下划线、点或连字符。',
  RATE_LIMITED: '操作过于频繁，请稍后再试。', REQUEST_TOO_LARGE: '提交内容过长。',
  IMAGE_TOO_LARGE: '图片需小于1MB，请先裁剪或压缩。', IMAGE_INVALID: '请选择有效的JPEG、PNG或WebP图片。',
  IMAGE_BYTES_BLOCKED: '解释或识读结果含有原图编码，未保存；请改用文字描述。',
  MODEL_OPERATION_FAILED: '模型请求未完成，请查看记录并重试。',
  INVALID_MODEL_OUTPUT: '模型结果未通过格式或证据校验，请手动重试。',
  CONTEXT_REQUIRED: '请先保存至少一句对方说的话，再请求聊天建议。',
  FEEDBACK_SOURCE_CHANGED: '实际发送记录已变化，请重新清理反馈后再审阅。',
  FOLLOWUP_REQUEST_CONFLICT: '这次录入编号已用于其他内容，请为新一轮创建新请求。',
  FOLLOWUP_SOURCE_ALREADY_LINKED: '上一轮草稿已关联过后续消息，请直接录入新的一句或选择本轮回复。',
  COPY_REQUEST_CONFLICT: '复制记录编号已用于其他内容，请重新复制。',
  MESSAGE_TIME_INVALID: '请填写有效的过去时间；录入时间会保留。',
  SUGGESTION_NOT_SENDABLE: '这是一条等待或暂停建议，没有需要发送的回复。',
  INVALID_STYLE_LEARNING: '表达偏好未保存，请检查本次自述或规则内容。',
  INVALID_STYLE_RULE: '请填写有效的表达偏好。',
  STYLE_REVISION_CONFLICT: '画像或表达偏好已更新，请重新载入后保存。',
  STYLE_REQUEST_CONFLICT: '这次保存编号已用于其他内容，请为新保存创建新请求。',
  STYLE_RULE_NOT_FOUND: '未找到你的这条表达偏好。',
  STYLE_RULE_STATE_INVALID: '这条候选的状态已变化，请重新载入。',
  STYLE_ACTIVE_LIMIT: '最多采用20条表达偏好，请先停用不再适用的规则。',
};

function parse(schema, value, code = 'INPUT_INVALID') {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BetaError(code);
  return parsed.data;
}
function normalizedError(error) {
  if (error instanceof BetaError) return error;
  const known = new Set([
    'FULL_QUESTIONNAIRE_PAID_ONLY', 'INVALID_PROFILE', 'INVALID_COUNTERPART', 'INVALID_MEETING', 'INVALID_MESSAGES',
    'PROFILE_REQUIRED', 'INVALID_INTENT', 'INVALID_FEEDBACK', 'INVALID_FEEDBACK_REVIEW', 'FEEDBACK_NOT_CLEANED',
    'FEEDBACK_QUARANTINED', 'FEEDBACK_CONSENT_REQUIRED', 'FEEDBACK_REVIEW_UNSAFE', 'INVALID_APPROVED_FEEDBACK',
    'KNOWLEDGE_WRITE_BUSY', 'KNOWLEDGE_VERSION_CONFLICT', 'KNOWLEDGE_READ_FAILED', 'KNOWLEDGE_APPEND_FAILED',
    'OUTPUT_KNOWLEDGE_EXCERPT_BLOCKED', 'OUTPUT_LIMIT_EXCEEDED',
    'INVALID_STYLE_LEARNING', 'INVALID_STYLE_RULE', 'STYLE_ACTIVE_LIMIT',
  ]);
  if (known.has(error?.code)) return new BetaError(error.code, error.code === 'FULL_QUESTIONNAIRE_PAID_ONLY' ? 403 : 400);
  if (error?.code === 'provider_http_error' && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599) return new BetaError(`PROVIDER_HTTP_${error.status}`, 502);
  const providerCodes = new Set(['missing_api_key', 'invalid_configuration', 'provider_timeout', 'invalid_provider_response', 'truncated_model_output', 'invalid_model_json', 'provider_unreachable', 'invalid_model_output', 'missing_model_tool_call', 'multiple_model_tool_calls', 'invalid_model_tool_call', 'unexpected_model_tool_call']);
  if (providerCodes.has(error?.code)) return new BetaError(error.code.toUpperCase(), 502);
  return new BetaError('MODEL_OPERATION_FAILED', 500);
}
const DIAGNOSTIC_CODES = new Set([
  'invalid_type', 'too_small', 'too_big', 'invalid_format', 'invalid_value', 'invalid_union', 'invalid_key', 'invalid_element', 'not_multiple_of', 'unrecognized_keys', 'custom',
  'invalid_direction_set', 'invalid_weight_sum', 'duplicate_evidence', 'invalid_evidence_reference', 'unknown_heat_with_evidence', 'observed_heat_without_evidence',
  'private_knowledge_excerpt', 'unknown_topic_with_evidence', 'unknown_topic_with_asserted_label', 'observed_topic_without_evidence', 'refusal_with_warming', 'unsupported_private_warming',
  'unknown_timing_with_evidence', 'unknown_timing_with_precision', 'missing_context_with_asserted_timing', 'adjusted_plan_required', 'unexpected_adjusted_plan',
]);
const DIAGNOSTIC_FIELDS = new Set([
  'status', 'confidence', 'phase', 'obstacle', 'type', 'evidenceIds', 'reason', 'heat', 'activeInteraction', 'responseEngagement', 'personalInterest', 'reciprocalFlirting', 'actionFollowThrough', 'level',
  'options', 'topicMove', 'relationAction', 'weight', 'uncertainties', 'recommendationKind', 'fieldCoach', 'currentTopic', 'topicStatus', 'topicMessageIds', 'initiative', 'nextAction', 'pitfall', 'warmingLayer',
  'reply', 'action', 'styleNote', 'verdict', 'timingSuggestion', 'guidance', 'adjustedPlan', 'relationMove', 'ownWordsGuide', 'reentryWhen', 'description', 'kind', 'uncertainty',
]);
function safeModelDiagnostics(error) {
  if (error?.code !== 'invalid_model_output' || !Array.isArray(error.diagnostics)) return [];
  return error.diagnostics.slice(0, 12).flatMap((item) => {
    if (!DIAGNOSTIC_CODES.has(item?.code) || !Array.isArray(item.path) || item.path.length > 8) return [];
    if (!item.path.every((part) => typeof part === 'string' ? DIAGNOSTIC_FIELDS.has(part) : Number.isInteger(part) && part >= 0 && part <= 1_000)) return [];
    // Never persist Zod messages, invalid values, model text or arbitrary keys.
    return [{ code: item.code, path: [...item.path] }];
  });
}
function errorBody(error) {
  const normalized = normalizedError(error);
  const provider = /^PROVIDER_HTTP_(\d{3})$/.exec(normalized.code);
  return { status: normalized.status, body: { error: { code: normalized.code, message: provider ? `模型服务返回 ${provider[1]}，请由 owner 检查服务端配置。` : MESSAGES[normalized.code] ?? '操作未完成，请检查输入或联系 owner。' } } };
}

function send(res, status, body) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function csrfMatches(actual, expected) {
  return typeof actual === 'string' && timingSafeEqual(Buffer.from(digest(actual), 'hex'), Buffer.from(digest(expected), 'hex'));
}
function cookieToken(req) {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header.length > 4_096) return undefined;
  const matches = header.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${AUTH_COOKIE}=`));
  return matches.length === 1 ? matches[0].slice(AUTH_COOKIE.length + 1) : undefined;
}
function setSessionCookie(res, session, secure) {
  res.setHeader('set-cookie', `${AUTH_COOKIE}=${session.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${secure ? '; Secure' : ''}`);
}
function body(req, limit = BODY_LIMIT) {
  return new Promise((resolve_, reject) => {
    const chunks = []; let length = 0; let settled = false;
    const fail = (error) => { if (settled) return; settled = true; req.removeListener('data', onData); req.resume(); reject(error); };
    const onData = (chunk) => { length += chunk.length; if (length > limit) return fail(new BetaError('REQUEST_TOO_LARGE', 413)); chunks.push(chunk); };
    req.on('data', onData);
    req.once('end', () => { if (settled) return; settled = true; try { resolve_(length === 0 ? {} : parse(JsonObject, JSON.parse(Buffer.concat(chunks).toString('utf8')))); } catch { reject(new BetaError('INPUT_INVALID')); } });
    req.once('aborted', () => fail(new BetaError('INPUT_INVALID')));
    req.once('error', () => fail(new BetaError('INPUT_INVALID')));
  });
}

async function serviceLock(dataDir) {
  const path = join(dataDir, 'server.lock');
  const workerId = randomUUID();
  let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw new BetaError('SERVICE_LOCK_FAILED', 500);
    const recoveryPath = `${path}.recovery`;
    let recovery;
    try { recovery = await open(recoveryPath, 'wx', 0o600); }
    catch { throw new BetaError('SERVICE_LOCK_UNVERIFIED', 409); }
    try {
      await recovery.writeFile(JSON.stringify({ pid: process.pid, workerId, createdAt: new Date().toISOString() }));
      let existing;
      try { existing = JSON.parse(await readFile(path, 'utf8')); } catch { throw new BetaError('SERVICE_LOCK_UNVERIFIED', 409); }
      if (!Number.isInteger(existing.pid) || existing.pid < 1 || typeof existing.workerId !== 'string') throw new BetaError('SERVICE_LOCK_UNVERIFIED', 409);
      try { process.kill(existing.pid, 0); throw new BetaError('SERVICE_ALREADY_RUNNING', 409); }
      catch (cause) { if (cause.code !== 'ESRCH') throw cause instanceof BetaError ? cause : new BetaError('SERVICE_LOCK_UNVERIFIED', 409); }
      // Only the holder of this recovery guard can replace a verified dead-process receipt.
      const current = JSON.parse(await readFile(path, 'utf8'));
      if (current.workerId !== existing.workerId) throw new BetaError('SERVICE_ALREADY_RUNNING', 409);
      await unlink(path);
      try { handle = await open(path, 'wx', 0o600); } catch { throw new BetaError('SERVICE_ALREADY_RUNNING', 409); }
    } finally { await recovery.close().catch(() => {}); await unlink(recoveryPath).catch(() => {}); }
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid, workerId, createdAt: new Date().toISOString() }));
  await handle.close();
  return { workerId, release() { try { unlinkSync(path); } catch {} } };
}

export async function createBetaServer({
  store: providedStore, ownsStore = providedStore === undefined, workerId, archiveKnowledge,
  dataDir, knowledgePath, webDir = providedStore === undefined ? join(PROJECT_ROOT, 'dist/public') : null, publicOrigin,
  classifyFn = classifyChat, replyFn = generateReply, planFn = generateFieldCoachPlan, imageFn = interpretChatImage, storeKnowledge,
  localDemoMode = false, hostedPreviewOwnerId,
  providerEnv = process.env,
  freeProviderDailyLimit = 10, paidProviderDailyLimit = 10, globalProviderDailyLimit = 100,
  now = Date.now,
} = {}) {
  if (typeof localDemoMode !== 'boolean') throw new BetaError('DEMO_CONFIGURATION_INVALID');
  const externalStore = providedStore !== undefined;
  if (typeof ownsStore !== 'boolean' || (externalStore && (!providedStore || !storeKnowledge || typeof archiveKnowledge !== 'function'))) throw new BetaError('STORE_CONFIGURATION_INVALID', 500);
  if (localDemoMode && externalStore) throw new BetaError('DEMO_LOCAL_STORE_REQUIRED', 400);
  if (hostedPreviewOwnerId !== undefined && (!externalStore || localDemoMode || !publicOrigin || typeof hostedPreviewOwnerId !== 'string' || !hostedPreviewOwnerId)) throw new BetaError('HOSTED_PREVIEW_CONFIGURATION_INVALID', 500);
  const { ensureLocalDemoSeed, assertLocalDemoRequest } = localDemoMode ? await import('./demo.mjs') : {};
  let canonicalOrigin;
  if (publicOrigin !== undefined) {
    try {
      const parsed = new URL(publicOrigin);
      const localHttp = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
      if ((parsed.protocol !== 'https:' && !localHttp) || parsed.origin !== publicOrigin || parsed.username || parsed.password) throw new Error();
      canonicalOrigin = parsed;
    }
    catch { throw new BetaError('PUBLIC_ORIGIN_INVALID'); }
  }
  if (localDemoMode && canonicalOrigin && !['127.0.0.1', 'localhost', '[::1]'].includes(canonicalOrigin.hostname)) throw new BetaError('DEMO_LOOPBACK_REQUIRED', 400);
  const assets = new Map();
  if (webDir !== null) {
    const directory = resolve(webDir);
    try {
      for (const [url, filename, type] of [['/', 'index.html', 'text/html; charset=utf-8'], ['/app.js', 'app.js', 'text/javascript; charset=utf-8'], ['/styles.css', 'styles.css', 'text/css; charset=utf-8']]) {
        const file = join(directory, filename); if (!(await stat(file)).isFile()) throw new Error();
        assets.set(url, { bytes: await readFile(file), type });
      }
    } catch { throw new BetaError('PUBLIC_BUILD_REQUIRED', 500); }
  }
  let directory, lock, store = providedStore;
  if (!externalStore) {
    directory = resolve(dataDir ?? join(PROJECT_ROOT, 'data/beta'));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Claim service ownership before SQLite initialization, so a losing server never races PRAGMA/schema setup.
    lock = await serviceLock(directory);
    try {
      const { createBetaStore } = await import('./beta-store.mjs');
      store = createBetaStore({ dataDir: directory, freeProviderDailyLimit, paidProviderDailyLimit, globalProviderDailyLimit, now });
      await store.recoverAbandonedJobs();
    } catch (error) { try { await store?.close(); } finally { lock.release(); } throw error; }
  }
  const serviceWorkerId = workerId ?? lock?.workerId ?? randomUUID();
  const knowledge = storeKnowledge ?? createKnowledgeStore({ knowledgePath });
  const archive = archiveKnowledge ?? (async (snapshot) => {
    const { archiveKnowledgeVersion } = await import('./case-snapshot.mjs');
    return await archiveKnowledgeVersion(directory, snapshot);
  });
  const inFlight = new Map();
  const reviewInFlight = new Map();
  let mcpHandler;
  const authWindows = new Map();
  const secure = canonicalOrigin?.protocol === 'https:';
  const withSnapshot = async (callback) => typeof store.withSnapshot === 'function' ? await store.withSnapshot(callback) : await callback();
  const withTransaction = async (callback) => typeof store.withTransaction === 'function' ? await store.withTransaction(callback) : await callback();

  async function visibleProfile(user) {
    const profile = await store.getProfile(user.id);
    if (user.plan === 'free' && profile?.questionnaire.kind === 'full') {
      return { background: profile.background, style: profile.style, growthGoals: profile.growthGoals, relationshipGoal: profile.relationshipGoal, questionnaire: { kind: 'short', answers: {} }, requiresQuestionnaireUpdate: true };
    }
    return profile;
  }
  async function capturedChatSnapshot(userId, counterpartId, { intent, allowEmpty = false } = {}) {
    return await withSnapshot(async () => {
      const account = await store.getUser(userId), profile = await store.getProfile(userId), counterpart = await store.getCounterpart(userId, counterpartId);
      if (!profile) throw new BetaError('PROFILE_REQUIRED');
      if (account.plan === 'free' && profile.questionnaire.kind === 'full') throw new BetaError('FULL_PROFILE_REQUIRES_UPDATE', 403);
      const { updatedAt: profileUpdatedAt, ...businessProfile } = profile;
      const { revision: counterpartRevision, ...businessCounterpart } = counterpart;
      const messages = await store.listMessages(userId, counterpartId);
      if (!allowEmpty && !messages.some((message) => message.speaker === 'other')) throw new BetaError('CONTEXT_REQUIRED');
      const context = buildChatContext(businessProfile, businessCounterpart, messages, { intent, meeting: await store.getMeeting(userId, counterpartId), personalStyle: await store.getAppliedPersonalStyle(userId) });
      return { context, profileUpdatedAt, counterpartRevision };
    });
  }
  async function chatSnapshot(userId, counterpartId, options) {
    return (await capturedChatSnapshot(userId, counterpartId, options)).context;
  }
  function contextHash(context, knowledgeHash, operation, options = {}) {
    const providerModel = typeof providerEnv.AGNES_MODEL === 'string' ? providerEnv.AGNES_MODEL.trim() : providerEnv.AGNES_MODEL ?? 'agnes-3.0-flash';
    return digest(JSON.stringify({ context, knowledgeHash, operation, direction: options.direction ?? null, ...(options.plan === undefined ? {} : { plan: options.plan }), ...(options.image ? { image: { hash: options.image.hash, mime: options.image.mime, bytes: options.image.bytes, explanation: options.explanation, version: IMAGE_INPUT_VERSION } } : {}), contextVersion: COACH_CONTEXT_VERSION, protocolVersion: COACH_PROTOCOL_VERSION, providerModel }));
  }
  async function currentClassification(userId, counterpartId, knowledgeSnapshot) {
    try {
      const context = await chatSnapshot(userId, counterpartId);
      const hash = contextHash(context, knowledgeSnapshot.hash, 'classify');
      const job = await store.latestSuccessful(userId, counterpartId, 'classify', hash);
      return job?.result ?? { classification: null, heat: computeHeat(null) };
    } catch (error) {
      if (['PROFILE_REQUIRED', 'FULL_PROFILE_REQUIRES_UPDATE', 'CONTEXT_REQUIRED'].includes(error.code)) return { classification: null, heat: computeHeat(null) };
      throw error;
    }
  }
  async function currentModelContext(userId, counterpartId, knowledgeSnapshot, suggestions) {
    try {
      const context = await chatSnapshot(userId, counterpartId);
      const classificationHash = contextHash(context, knowledgeSnapshot.hash, 'classify');
      const directHash = contextHash(context, knowledgeSnapshot.hash, 'reply');
      const directJob = await store.latestSuccessful(userId, counterpartId, 'reply', directHash);
      const conversationHash = contextHash(context, knowledgeSnapshot.hash, 'conversation');
      // Return IDs only: full immutable inputs and knowledge stay server-side.
      const cases = await Promise.all(suggestions.map(async (suggestion) => await store.getSuggestionCase(userId, counterpartId, suggestion.id)));
      const currentSuggestionIds = suggestions.filter((_, index) => cases[index].snapshot?.baseContextHash === conversationHash).map(({ id }) => id);
      return { currentSuggestionIds, directReply: directJob?.result?.suggestion ? await store.getSuggestion(userId, counterpartId, directJob.result.suggestion.id) : null, latestCoachPlan: await store.latestCoachPlan(userId, counterpartId, conversationHash), modelContext: { classificationAttempted: await store.hasModelAttempt(userId, counterpartId, 'classify', classificationHash), directReplyAttempted: await store.hasModelAttempt(userId, counterpartId, 'reply', directHash) } };
    } catch (error) {
      if (['PROFILE_REQUIRED', 'FULL_PROFILE_REQUIRES_UPDATE', 'CONTEXT_REQUIRED'].includes(error.code)) return { currentSuggestionIds: [], directReply: null, latestCoachPlan: null, modelContext: { classificationAttempted: false, directReplyAttempted: false } };
      throw error;
    }
  }

  async function runModel(userId, counterpartId, operation, input) {
    const currentResult = async (result) => {
      if (operation === 'image_read') guardImageBytes(result.imageInterpretation, input.image);
      return result.suggestion ? { ...result, suggestion: await store.getSuggestion(userId, counterpartId, result.suggestion.id) } : result;
    };
    const knowledgeSnapshot = await knowledge.read();
    const snapshotOptions = { intent: operation === 'reply' ? input.intent : undefined, allowEmpty: operation === 'image_read' };
    const { context, profileUpdatedAt, counterpartRevision } = await capturedChatSnapshot(userId, counterpartId, snapshotOptions);
    const hash = contextHash(context, knowledgeSnapshot.hash, operation, input);
    const model = typeof providerEnv.AGNES_MODEL === 'string' ? providerEnv.AGNES_MODEL.trim() : providerEnv.AGNES_MODEL ?? 'agnes-3.0-flash';
    const classificationContext = { ...context }; delete classificationContext.intent;
    const classified = operation === 'reply' ? await store.latestSuccessful(userId, counterpartId, 'classify', contextHash(classificationContext, knowledgeSnapshot.hash, 'classify')) : null;
    const capturedAt = new Date(now()).toISOString();
    const archived = await archive(knowledgeSnapshot);
    const contextSnapshot = { schemaVersion: 'coach-case-1', capturedAt, modelInput: context, profileUpdatedAt, counterpartRevision, baseContextHash: contextHash(classificationContext, knowledgeSnapshot.hash, 'conversation'), ...(input.plan === undefined ? {} : { request: { plan: input.plan } }),
      ...(input.image ? { image: { hash: input.image.hash, mime: input.image.mime, bytes: input.image.bytes, version: IMAGE_INPUT_VERSION, explanation: { source: 'user_interpretation', text: input.explanation } } } : {}),
      knowledge: archived, model: { name: model, contextVersion: COACH_CONTEXT_VERSION, protocolVersion: COACH_PROTOCOL_VERSION },
      choice: { requestedDirection: input.direction ?? null, source: operation === 'image_read' ? 'image_read' : operation === 'classify' ? 'classification' : operation === 'coach_plan' ? 'user_plan' : input.direction ? 'user_choice' : 'direct_reply', classificationJobId: classified?.id ?? null, classificationResult: classified?.result ?? null } };
    if (typeof store.recoverExpiredJobs === 'function') await store.recoverExpiredJobs();
    const reserved = await store.reserveJob({ userId, counterpartId, operation, requestId: input.requestId, contextHash: hash, knowledgeHash: knowledgeSnapshot.hash, workerId: serviceWorkerId, providerModel: model, contextSnapshot });
    if (!reserved.fresh) {
      if (reserved.job.state === 'succeeded') return { ...await currentResult(reserved.job.result), cached: true, quota: await store.quota(userId) };
      if (reserved.job.state === 'failed') throw new BetaError(reserved.job.errorCode ?? 'JOB_INTERRUPTED', 409);
      const running = inFlight.get(reserved.job.id);
      if (!running) throw new BetaError('JOB_IN_PROGRESS', 409);
      const result = await running;
      return { ...await currentResult(result), cached: true, quota: await store.quota(userId) };
    }
    const job = reserved.job;
    const pending = (async () => {
      try {
        await store.markJobRunning(job.id);
        const options = { knowledgeText: knowledgeSnapshot.text, env: providerEnv };
        let output = operation === 'classify'
          ? await classifyFn(context, options)
          : operation === 'image_read' ? await imageFn({ context, image: input.image, explanation: input.explanation }, options)
          : operation === 'coach_plan' ? await planFn({ context, plan: input.plan }, options)
          : await replyFn({ context, ...(input.direction === undefined ? {} : { direction: input.direction }) }, options);
        guardRestrictedOutput(output, knowledgeSnapshot.text);
        if (operation === 'image_read') output = validateImageInterpretation(output, input.image);
        return await withTransaction(async () => {
          const currentKnowledge = await knowledge.read();
          const currentContext = await chatSnapshot(userId, counterpartId, snapshotOptions);
          if (contextHash(currentContext, currentKnowledge.hash, operation, input) !== hash) throw new BetaError('CONTEXT_CHANGED', 409);
          let result, suggestion;
          if (operation === 'classify') {
            const previous = await store.previousClassification(userId, counterpartId);
            const classification = { ...output, knowledgeHash: knowledgeSnapshot.hash, contextHash: hash };
            result = { classification, heat: computeHeat(output, { history: previous ? [previous.result.heat] : [], observedAt: new Date(now()).toISOString() }) };
          } else if (operation === 'reply') {
            suggestion = { ...output, id: randomUUID(), direction: input.direction ?? null, knowledgeHash: knowledgeSnapshot.hash, contextHash: hash };
            result = { suggestion };
          } else if (operation === 'image_read') result = { imageInterpretation: { ...output, source: 'ai_image_description', userExplanation: { source: 'user_interpretation', text: input.explanation }, image: { hash: input.image.hash, mime: input.image.mime, bytes: input.image.bytes } } };
          else result = { planAssessment: output };
          await store.completeJob(job.id, result, suggestion);
          return result;
        });
      } catch (error) {
        const diagnostics = safeModelDiagnostics(error);
        const safe = normalizedError(error);
        await store.failJob(job.id, safe.code, diagnostics.length ? { diagnostics } : undefined);
        throw safe;
      }
    })();
    inFlight.set(job.id, pending);
    try { return { ...await currentResult(await pending), cached: false, quota: await store.quota(userId) }; }
    finally { if (inFlight.get(job.id) === pending) inFlight.delete(job.id); }
  }

  async function approveKnowledge(ownerId, feedback, reviewInput) {
    const receipt = reviewFeedback(feedback.cleaning, reviewInput);
    const reviewHash = digest(JSON.stringify({ review: receipt.review, purpose: receipt.purpose, dedupKey: receipt.dedupKey }));
    if (feedback.review) {
      if (feedback.review.reviewHash !== reviewHash) throw new BetaError('REVIEW_CONFLICT', 409);
      return feedback;
    }
    const pendingApproval = await store.getKnowledgeApproval(ownerId, feedback.id);
    if (pendingApproval) {
      if (pendingApproval.review_hash !== reviewHash) throw new BetaError('REVIEW_CONFLICT', 409);
      const current = await knowledge.read();
      if (current.text.includes(pendingApproval.marker)) return await store.finishKnowledgeApproval(ownerId, feedback.id, current.hash);
    }
    if (receipt.stage === 'approved_candidate') {
      const source = feedback.raw.payload;
      const sent = await store.findSentMessage(feedback.user.id, feedback.counterpartId, source.suggestionId, source.actualSentText);
      if (!sent || sent.id !== feedback.cleaning.provenance.actualSentMessageId) throw new BetaError('FEEDBACK_SOURCE_CHANGED', 409);
    }
    if (receipt.stage !== 'approved_candidate' || receipt.purpose !== 'knowledge') return await store.saveReview(ownerId, feedback.id, { ...receipt, reviewHash });
    const counterpart = await store.getCounterpart(feedback.user.id, feedback.counterpartId);
    const supplement = buildFeedbackKnowledgeSupplement(receipt, { identifiers: [feedback.user.username, counterpart.alias] });
    if (supplement.length > 31_000) throw new BetaError('SUPPLEMENT_TOO_LARGE');
    const approval = await store.beginKnowledgeApproval(ownerId, feedback.id, reviewHash, { ...receipt, reviewHash }, supplement);
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = await knowledge.read();
      if (current.text.includes(approval.marker)) return await store.finishKnowledgeApproval(ownerId, feedback.id, current.hash);
      try {
        const appended = await knowledge.append({ expectedHash: current.hash, content: `${approval.marker}\n${approval.supplement}` });
        return await store.finishKnowledgeApproval(ownerId, feedback.id, appended.hash);
      } catch (error) {
        if (error.code !== 'KNOWLEDGE_VERSION_CONFLICT' || attempt === 3) throw error;
      }
    }
    throw new BetaError('KNOWLEDGE_VERSION_CONFLICT', 409);
  }

  async function dispatch(user, method, path, input = {}) {
    const userId = user.id;
    if (path === '/api/me' && method === 'GET') return { user, profile: await visibleProfile(user), quota: await store.quota(userId) };
    if (path === '/api/profile' && method === 'PUT') {
      const { styleLearning, ...profile } = parse(ProfileSaveSchema, input, input.styleLearning === undefined ? 'INVALID_PROFILE' : 'INVALID_STYLE_LEARNING');
      return await store.saveProfileAndStyle(userId, validateProfile(profile, user.plan), styleLearning);
    }
    if (path === '/api/style-learning' && method === 'GET') return await store.getStyleLearning(userId);
    if (path === '/api/counterparts' && method === 'GET') {
      const knowledgeSnapshot = await knowledge.read();
      const counterparts = await Promise.all((await store.listCounterparts(userId)).map(async (counterpart) => ({ ...counterpart, heat: (await currentClassification(userId, counterpart.id, knowledgeSnapshot)).heat })));
      return { counterparts, topThree: rankTopThree(counterparts) };
    }
    if (path === '/api/counterparts' && method === 'POST') return { counterpart: await store.putCounterpart(userId, parse(CounterpartInputSchema, input, 'INVALID_COUNTERPART')) };
    const counterpartRoute = /^\/api\/counterparts\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (counterpartRoute) {
      const [, id, action] = counterpartRoute;
      const counterpart = await store.getCounterpart(userId, id);
      if (!action && method === 'GET') {
        const knowledgeSnapshot = await knowledge.read();
        const observed = await currentClassification(userId, id, knowledgeSnapshot);
        const jobs = (await store.listJobs(userId, id)).map(({ id: jobId, operation, state, errorCode, createdAt, updatedAt, knowledgeHash, cacheOf }) => ({ id: jobId, operation, state, errorCode, createdAt, updatedAt, knowledgeHash, cached: Boolean(cacheOf) }));
        const suggestions = await store.listSuggestions(userId, id);
        return { counterpart, messages: await store.listMessages(userId, id), suggestions, ...observed, ...await currentModelContext(userId, id, knowledgeSnapshot, suggestions), meeting: await store.getMeeting(userId, id), jobs };
      }
      if (!action && method === 'PUT') return { counterpart: await store.putCounterpart(userId, parse(CounterpartInputSchema, input, 'INVALID_COUNTERPART'), id) };
      if (!action && method === 'DELETE') { await store.deleteCounterpart(userId, id); return { deleted: true }; }
      if (action === 'messages' && method === 'POST') return { message: await store.putMessage(userId, id, parse(MessageSchema, input)) };
      if (action === 'followup' && method === 'POST') return await store.recordFollowup(userId, id, parse(FollowupSchema, input));
      const copied = /^suggestions\/([^/]+)\/copied$/.exec(action ?? '');
      if (copied && method === 'POST') return await store.recordReplyCopy(userId, id, copied[1], parse(CopySchema, input));
      const messageTime = /^messages\/([^/]+)\/timing$/.exec(action ?? '');
      if (messageTime && method === 'PATCH') return { message: await store.putMessageTime(userId, id, messageTime[1], parse(MessageTimeSchema, input).actualWechatAt) };
      const message = /^messages\/([^/]+)$/.exec(action ?? '');
      if (message && method === 'PUT') return { message: await store.putMessage(userId, id, parse(MessageSchema, input), message[1]) };
      if (message && method === 'DELETE') { await store.deleteMessage(userId, id, message[1]); return { deleted: true }; }
      if (action === 'classify' && method === 'POST') return runModel(userId, id, 'classify', parse(ClassifySchema, input));
      if (action === 'reply' && method === 'POST') return runModel(userId, id, 'reply', parse(ReplySchema, input));
      if (action === 'image-read' && method === 'POST') {
        const request = parse(ImageReadSchema, input);
        const image = validateChatImage(request.image);
        guardImageBytes(request.explanation, image);
        return runModel(userId, id, 'image_read', { ...request, image });
      }
      if (action === 'coach-plan' && method === 'POST') return runModel(userId, id, 'coach_plan', parse(PlanInputSchema, input));
      if (action === 'sent' && method === 'POST') {
        const sent = parse(SentSchema, input);
        await store.getSuggestion(userId, id, sent.suggestionId);
        return { message: await store.putMessage(userId, id, { speaker: 'self', text: sent.actualSentText, suggestionId: sent.suggestionId }) };
      }
      if (action === 'meeting' && method === 'PUT') return { meeting: await store.putMeeting(userId, id, parse(MeetingInputSchema, input, 'INVALID_MEETING')) };
      if (action === 'feedback' && method === 'POST') {
        const feedback = parse(FeedbackInputSchema, input, 'INVALID_FEEDBACK');
        await store.getSuggestion(userId, id, feedback.suggestionId);
        return await store.addFeedback(userId, id, feedback);
      }
    }
    if (path.startsWith('/api/admin/')) {
      if (user.role !== 'owner') throw new BetaError('OWNER_REQUIRED', 403);
      if (path === '/api/admin/invites' && method === 'POST') return await store.createInvite({ ownerId: userId, ...parse(PlanSchema, input) });
      if (path === '/api/admin/users' && method === 'GET') return { users: await store.listUsers(userId) };
      const plan = /^\/api\/admin\/users\/([^/]+)\/plan$/.exec(path);
      if (plan && method === 'PUT') return { user: await store.updatePlan({ ownerId: userId, userId: plan[1], ...parse(PlanSchema, input) }) };
      const mcpToken = /^\/api\/admin\/users\/([^/]+)\/mcp-token$/.exec(path);
      if (mcpToken && method === 'POST') { parse(z.strictObject({}), input); return await store.createMcpToken({ ownerId: userId, userId: mcpToken[1] }); }
      if (path === '/api/admin/feedback' && method === 'GET') return { feedback: await store.listFeedback(userId) };
      const feedbackAction = /^\/api\/admin\/feedback\/([^/]+)\/(clean|review)$/.exec(path);
      if (feedbackAction && method === 'POST') {
        const feedback = await store.getFeedback(userId, feedbackAction[1]);
        if (feedbackAction[2] === 'clean') {
          parse(z.strictObject({}), input);
          const payload = feedback.raw.payload;
          const inferred = feedback.raw.sourceMode === 'beta_followup';
          const suggestion = payload.suggestionId ? await store.getSuggestion(feedback.user.id, feedback.counterpartId, payload.suggestionId) : undefined;
          const sent = inferred ? feedback.raw.caseEvidence?.previousMessage : await store.findSentMessage(feedback.user.id, feedback.counterpartId, payload.suggestionId, payload.actualSentText);
          const counterpart = await store.getCounterpart(feedback.user.id, feedback.counterpartId);
          let candidate = cleanFeedback(payload, { suggestion, actualSentMessage: sent, sourceId: feedback.id, identifiers: [feedback.user.username, counterpart.alias] });
          if (inferred) candidate = { ...candidate, stage: 'quarantined', consent: false, allowedPurposes: [], flags: [...new Set([...(candidate.flags ?? []), 'inferred_followup', 'sending_unverified', 'no_training_consent'])] };
          return { feedback: await store.saveCleaning(userId, feedback.id, candidate) };
        }
        const reviewInput = parse(ReviewInputSchema, input, 'INVALID_FEEDBACK_REVIEW');
        if (!feedback.cleaning) throw new BetaError('FEEDBACK_NOT_CLEANED');
        const running = reviewInFlight.get(feedback.id);
        if (running) { await running; return { feedback: await approveKnowledge(userId, await store.getFeedback(userId, feedback.id), reviewInput) }; }
        const pending = approveKnowledge(userId, feedback, reviewInput);
        reviewInFlight.set(feedback.id, pending);
        try { return { feedback: await pending }; }
        finally { if (reviewInFlight.get(feedback.id) === pending) reviewInFlight.delete(feedback.id); }
      }
    }
    throw new BetaError('NOT_FOUND', 404);
  }

  function requestOrigin(req) {
    const host = req.headers.host;
    if (typeof host !== 'string' || host.includes(',') || host.length > 200) throw new BetaError('HOST_FORBIDDEN', 403);
    if (canonicalOrigin) {
      if (host.toLowerCase() !== canonicalOrigin.host.toLowerCase()) throw new BetaError('HOST_FORBIDDEN', 403);
      return canonicalOrigin.origin;
    }
    let parsed;
    try { parsed = new URL(`http://${host}`); } catch { throw new BetaError('HOST_FORBIDDEN', 403); }
    if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || parsed.username || parsed.password) throw new BetaError('HOST_FORBIDDEN', 403);
    return parsed.origin;
  }
  async function authRate(req) {
    const key = req.socket.remoteAddress ?? 'unknown', timestamp = now();
    if (typeof store.takeRateLimit === 'function') {
      const result = await store.takeRateLimit({ key: `auth:${key}`, limit: 20, windowMs: 60_000 });
      if (!result.allowed) throw new BetaError('RATE_LIMITED', 429);
      return;
    }
    let window = authWindows.get(key);
    if (!window || timestamp - window.start >= 60_000) { window = { start: timestamp, count: 0 }; authWindows.set(key, window); }
    if (++window.count > 20) throw new BetaError('RATE_LIMITED', 429);
  }
  const server = createServer(async (req, res) => {
    try {
      if (localDemoMode) assertLocalDemoRequest(req);
      const origin = requestOrigin(req);
      const url = new URL(req.url, origin);
      if (url.search) throw new BetaError('INPUT_INVALID');
      const path = url.pathname;
      if (path === '/mcp') {
        if (localDemoMode) throw new BetaError('NOT_FOUND', 404);
        if (req.headers.origin && req.headers.origin !== origin) throw new BetaError('ORIGIN_FORBIDDEN', 403);
        if (!mcpHandler) throw new BetaError('NOT_FOUND', 404);
        return await mcpHandler(req, res);
      }
      const mutation = !['GET', 'HEAD'].includes(req.method);
      if (mutation && req.headers.origin !== origin) throw new BetaError('ORIGIN_FORBIDDEN', 403);
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('referrer-policy', 'no-referrer');
      res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
      if ((path === '/health' || path === '/api/health') && req.method === 'GET') return send(res, 200, { data: { service: 'wechat-chat-coach', version: packageMetadata.version } });
      if (path === '/api/meta' && req.method === 'GET') return send(res, 200, { data: { name: '聊天训练助手 · 内测', questionnaires: QUESTIONNAIRES, localDemo: { enabled: localDemoMode, synthetic: localDemoMode }, hostedPreview: { enabled: Boolean(hostedPreviewOwnerId) }, privacy: '聊天与画像按账户隔离；手动记录发送，不自动联系微信。反馈先隔离、清理和owner审阅；建议权重不是成功概率。' } });
      if (path === '/api/preview/session') {
        if (!hostedPreviewOwnerId || req.method !== 'POST') throw new BetaError('NOT_FOUND', 404);
        parse(z.strictObject({}), await body(req));
        await authRate(req);
        const previewOwner = await store.getUser(hostedPreviewOwnerId);
        if (previewOwner.role !== 'owner') throw new BetaError('OWNER_REQUIRED', 403);
        const session = await store.createSession(previewOwner.id);
        setSessionCookie(res, session, secure);
        return send(res, 200, { data: { user: previewOwner, csrfToken: session.csrfToken } });
      }
      if (path === '/api/demo/session') {
        if (!localDemoMode || req.method !== 'POST') throw new BetaError('NOT_FOUND', 404);
        parse(z.strictObject({}), await body(req));
        const seed = await ensureLocalDemoSeed(store);
        const session = await store.createSession(seed.user.id); setSessionCookie(res, session, secure);
        return send(res, 200, { data: { ...seed, csrfToken: session.csrfToken } });
      }
      if (localDemoMode && (path === '/api/register' || path === '/api/login' || path.startsWith('/api/admin/'))) throw new BetaError('NOT_FOUND', 404);
      if (['/api/register', '/api/login'].includes(path) && req.method === 'POST') {
        await authRate(req);
        const input = await body(req);
        const user = path === '/api/register' ? await store.register(parse(RegisterSchema, input)) : await store.authenticate(parse(LoginSchema, input));
        const session = await store.createSession(user.id); setSessionCookie(res, session, secure);
        return send(res, 200, { data: { user, csrfToken: session.csrfToken } });
      }
      if (path.startsWith('/api/')) {
        const rawToken = cookieToken(req), session = await store.lookupSession(rawToken);
        if (!session) throw new BetaError('UNAUTHORIZED', 401);
        if (mutation && !csrfMatches(req.headers['x-csrf-token'], session.csrfToken)) throw new BetaError('CSRF_INVALID', 403);
        if (path === '/api/logout' && req.method === 'POST') {
          await store.removeSession(rawToken); res.setHeader('set-cookie', `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`);
          return send(res, 200, { data: { loggedOut: true } });
        }
        const imageEntry = req.method === 'POST' && /^\/api\/counterparts\/[^/]+\/image-read$/.test(path);
        const result = await dispatch(session.user, req.method, path, mutation ? await body(req, imageEntry ? IMAGE_BODY_LIMIT : BODY_LIMIT) : {});
        if (path === '/api/me') result.csrfToken = session.csrfToken;
        return send(res, 200, { data: result });
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const asset = assets.get(path);
        if (asset) { res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' }); return res.end(req.method === 'HEAD' ? undefined : asset.bytes); }
      }
      throw new BetaError('NOT_FOUND', 404);
    } catch (error) { const sanitized = errorBody(error); send(res, sanitized.status, sanitized.body); }
  });
  server.betaStore = store;
  server.ensureDemoSeed = async () => { if (!localDemoMode) throw new BetaError('NOT_FOUND', 404); return ensureLocalDemoSeed(store); };
  server.setMcpHandler = (handler) => { if (typeof handler !== 'function') throw new BetaError('MCP_HANDLER_INVALID'); mcpHandler = handler; };
  server.invokeForAccount = async ({ accountId, method, path, body: input = {} }) => {
    const allowed = method === 'GET' && (path === '/api/counterparts' || /^\/api\/counterparts\/[^/]+$/.test(path))
      || method === 'POST' && /^\/api\/counterparts\/[^/]+\/(classify|reply|feedback)$/.test(path);
    if (!allowed) throw new BetaError('MCP_OPERATION_FORBIDDEN', 403);
    try { return { data: await dispatch(await store.getUser(accountId), method, path, input) }; }
    catch (error) { throw normalizedError(error); }
  };
  server.storeClosed = Promise.resolve();
  server.once('close', () => {
    server.storeClosed = (async () => { try { if (ownsStore) await store.close(); } finally { lock?.release(); } })();
    // Expose cleanup completion without an unhandled rejection from an EventEmitter listener.
    server.storeClosed.catch(() => {});
  });
  return server;
}
