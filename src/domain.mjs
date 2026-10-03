import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { ChatMessageSchema } from './chat-record.mjs';
import { validateAppliedPersonalStyle } from './style-learning.mjs';

export class DomainError extends Error {
  constructor(code) {
    super(code);
    this.name = 'DomainError';
    this.code = code;
  }
}

const text = (maximum = 20_000) => z.string().trim().max(maximum);
const requiredText = (maximum = 20_000) => text(maximum).min(1);

const QUESTION_GROUPS = [
  ['directness', '表达直接度', [
    ['想了解对方时，我愿意直接提出一个清楚的问题。'],
    ['即使想表达好感，我也常把意思藏在模糊的提示里。', true],
    ['我可以用简单的话告诉对方自己的真实想法。'],
    ['担心被拒绝时，我会回避说出自己想要什么。', true],
    ['提出见面时，我更愿意给一个明确但可拒绝的建议。'],
    ['我倾向让对方猜出我的意思，而不是清楚表达。', true],
  ]],
  ['warmth', '关注与回应偏好', [
    ['对方说累或烦时，我会先回应她的感受。'],
    ['聊天里我通常只接事情，很少回应对方的感受。', true],
    ['我愿意分享一点自己的感受，帮助对方了解我。'],
    ['我觉得认真回应情绪会让我显得不自然。', true],
    ['我能具体说出对方哪一点让我欣赏。'],
    ['我更习惯迅速转到下一个问题，而不是接住感受。', true],
  ]],
  ['playfulness', '轻松玩笑偏好', [
    ['双方都轻松时，我喜欢带一点幽默或调侃。'],
    ['即使气氛轻松，我也更喜欢一直保持正式。', true],
    ['我能用生活里的小观察开启轻松的话题。'],
    ['我通常很难判断玩笑会不会让对方不舒服。', true],
    ['发现玩笑没被接住时，我愿意自然地换个表达。'],
    ['我觉得只有很用力的段子才能让聊天有趣。', true],
  ]],
  ['curiosity', '共同探索偏好', [
    ['对方提到一个经历时，我会想了解其中一个具体细节。'],
    ['我常急着讲自己的故事，忘记接对方刚说的内容。', true],
    ['我会留意对方主动展开的是哪些话题。'],
    ['聊天时我通常按照自己准备的问题依次问下去。', true],
    ['我愿意在提问之外，也分享与这个话题有关的自己。'],
    ['对方的回答不合预期时，我容易坚持原来的话题。', true],
  ]],
  ['pacing', '节奏谨慎偏好', [
    ['表达更明显的好感前，我会留意双方是否在互相接话。'],
    ['即使还不了解对方，我也喜欢很快推进到暧昧话题。', true],
    ['对方有疑虑时，我愿意先理解疑虑再决定下一步。'],
    ['只要对方回复了，我通常就认为可以继续升级。', true],
    ['我能接受暂缓推进，让双方先建立更自然的互动。'],
    ['我经常因为想尽快有结果而忽略对方的节奏。', true],
  ]],
];

function makeQuestions(kind, perDimension) {
  let index = 0;
  return Object.freeze(QUESTION_GROUPS.flatMap(([dimension, _label, questions]) => questions.slice(0, perDimension).map(([question, reverse]) => Object.freeze({
    id: `${kind === 'short' ? 's' : 'f'}${String(++index).padStart(2, '0')}`,
    text: question,
    dimension,
    ...(reverse ? { reverse: true } : {}),
  }))));
}

export const QUESTIONNAIRES = Object.freeze({ short: makeQuestions('short', 2), full: makeQuestions('full', 6) });
export const QUESTIONNAIRE_VERSION = 'custom-chat-preferences-1';
export const QUESTIONNAIRE_CHOICES = Object.freeze([1, 2, 3, 4, 5]);

const QuestionnaireSchema = z.strictObject({
  kind: z.enum(['short', 'full']),
  answers: z.record(z.string(), z.number().int().min(1).max(5)),
}).superRefine(({ kind, answers }, context) => {
  const expected = new Set(QUESTIONNAIRES[kind].map(({ id }) => id));
  if (Object.keys(answers).some((id) => !expected.has(id))) {
    context.addIssue({ code: 'custom', path: ['answers'], message: 'Answer only items from the selected questionnaire.' });
  }
});

export const ProfileInputSchema = z.strictObject({
  background: text().default(''),
  style: text(10_000).default(''),
  growthGoals: text(10_000).default(''),
  relationshipGoal: text(10_000).default(''),
  questionnaire: QuestionnaireSchema.nullable().default(null),
});

export const CounterpartInputSchema = z.strictObject({
  alias: requiredText(80),
  remark: text(200).default(''),
  channel: z.enum(['app', 'offline', 'other']).default('other'),
  appProfile: text().default(''),
  offlineScene: text().default(''),
  background: text().default(''),
  rounds: z.number().int().min(0).max(100_000).nullable().default(null),
});

export const MeetingInputSchema = z.strictObject({
  status: z.enum(['none', 'proposed', 'alternative', 'confirmed', 'declined']),
  time: text(500).default(''),
  place: text(500).default(''),
  note: text(2_000).default(''),
}).superRefine((value, context) => {
  if (value.status === 'confirmed' && (!value.time || !value.place)) context.addIssue({ code: 'custom', message: 'Confirmed meetings require a time and place.' });
});

export const FeedbackInputSchema = z.strictObject({
  suggestionId: requiredText(128),
  actualSentText: text(5_000),
  counterpartReply: text(5_000),
  observation: text(5_000),
  kind: z.enum(['positive', 'pitfall', 'uncertain']),
  consent: z.boolean(),
});

export const ReviewInputSchema = z.strictObject({
  decision: z.enum(['approve', 'reject']),
  purpose: z.enum(['knowledge', 'evaluation']),
  conditions: text(5_000),
  limits: text(5_000),
  note: text(5_000).default(''),
}).superRefine((value, context) => {
  if (value.decision === 'approve' && (!value.conditions || !value.limits)) context.addIssue({ code: 'custom', message: 'Approval requires explicit conditions and limits.' });
});

function parse(schema, value, code) {
  const result = schema.safeParse(value);
  if (!result.success) throw new DomainError(code);
  return result.data;
}

export function validateProfile(input, plan = 'free') {
  const profile = parse(ProfileInputSchema, input, 'INVALID_PROFILE');
  if (profile.questionnaire?.kind === 'full' && plan !== 'paid') throw new DomainError('FULL_QUESTIONNAIRE_PAID_ONLY');
  return { ...profile, questionnaireVersion: QUESTIONNAIRE_VERSION, questionnaireHypotheses: analyzeQuestionnaire(profile.questionnaire) };
}

export function analyzeQuestionnaire(questionnaire) {
  if (questionnaire === undefined || questionnaire === null) return null;
  const { kind, answers } = parse(QuestionnaireSchema, questionnaire, 'INVALID_QUESTIONNAIRE');
  if (Object.keys(answers).length === 0) return null;
  const dimensions = Object.fromEntries(QUESTION_GROUPS.map(([dimension, label]) => {
    const items = QUESTIONNAIRES[kind].filter((item) => item.dimension === dimension && Object.hasOwn(answers, item.id));
    const values = items.map((item) => item.reverse ? 6 - answers[item.id] : answers[item.id]);
    const mean = values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 100) / 100 : null;
    return [dimension, { label, mean, itemCount: items.length, basis: 'self_report', status: items.length ? 'hypothesis' : 'unknown' }];
  }));
  return { version: QUESTIONNAIRE_VERSION, kind, dimensions, interpretation: 'Custom self-reported chat preferences; provisional hypotheses, not a validated personality test or an official type.' };
}

const StoredProfileSchema = ProfileInputSchema.extend({ questionnaireVersion: z.string().optional(), questionnaireHypotheses: z.unknown().optional() });
const StoredCounterpartSchema = CounterpartInputSchema.extend({ id: z.string().optional(), updatedAt: z.string().optional(), createdAt: z.string().optional() });
const MessageSchema = ChatMessageSchema.strip().extend({ id: requiredText(128), text: requiredText(20_000) });
const ManualMeetingBoundarySchema = z.strictObject({
  source: z.literal('user_recorded_meeting'),
  messageIdsAtSave: z.array(requiredText(128)).refine((ids) => new Set(ids).size === ids.length).nullable(),
});

export function buildChatContext(profileInput, counterpartInput, messageInput, { intent, meeting, manualMeetingBoundary, personalStyle, topicChangeRequested } = {}) {
  const profile = parse(StoredProfileSchema, profileInput ?? {}, 'PROFILE_REQUIRED');
  const counterpart = parse(StoredCounterpartSchema, counterpartInput, 'INVALID_COUNTERPART');
  const messages = parse(z.array(MessageSchema), messageInput, 'INVALID_MESSAGES');
  if (new Set(messages.map(({ id }) => id)).size !== messages.length) throw new DomainError('INVALID_MESSAGES');
  if (topicChangeRequested !== undefined && typeof topicChangeRequested !== 'boolean') throw new DomainError('INVALID_TOPIC_REQUEST');
  const meetingBoundary = manualMeetingBoundary === undefined ? undefined : parse(ManualMeetingBoundarySchema, manualMeetingBoundary, 'INVALID_MEETING_BOUNDARY');
  if (meetingBoundary && meeting === undefined) throw new DomainError('INVALID_MEETING_BOUNDARY');
  const personalContext = {
    background: profile.background,
    currentStyle: profile.style,
    growthGoals: profile.growthGoals,
    relationshipGoal: profile.relationshipGoal,
    questionnaire: profile.questionnaire ? {
      version: QUESTIONNAIRE_VERSION,
      kind: profile.questionnaire.kind,
      answers: QUESTIONNAIRES[profile.questionnaire.kind].filter((item) => Object.hasOwn(profile.questionnaire.answers, item.id)).map((item) => ({ ...item, answer: profile.questionnaire.answers[item.id] })),
    } : null,
    questionnaireHypotheses: analyzeQuestionnaire(profile.questionnaire),
    interpretationRule: 'Keep real background, current expression and learning goals separate. Missing background, style, goals and questionnaire answers are unknown; do not infer personality from blank fields or impute neutral answers. Questionnaire summaries are self-report hypotheses based only on answered items; prefer actual conversation evidence. Do not fabricate identity or experiences. One round is one complete topic, not one message. By default proactively attempt one mild A warming per complete topic, then adapt to feedback; 10–20 messages is only a topic check-in reference. A is a shallow sincere evaluation or definition, B the male-to-female romantic frame, and C a clear private or intimate implication; comfort and positive interaction are prerequisites for C rather than its definition. Unknown does not justify C; respect explicit refusals.',
    relationshipInterpretation: 'This coaching concerns voluntary intimacy between adults; the current product stage is online interaction toward a mutually agreed offline meeting. Sexual attraction, trust and willingness to pursue a romantic relationship are separate questions with separate evidence, not interchangeable scores. Heat, flirting, a meeting or past intimacy is not consent to another act, and sex does not guarantee a romantic relationship.',
  };
  if (personalStyle !== undefined) {
    personalContext.confirmedPersonalStyle = validateAppliedPersonalStyle(personalStyle);
    personalContext.interpretationRule += ' Confirmed account expression preferences and learning goals are self-reported choices, not demonstrated effectiveness or already-acquired traits. Apply their stated conditions and limits; empty conditions mean unspecified, not universally effective. They never override real identity, the current request or explicit boundaries. Unconfirmed proposals, personal case ratings and external observations are not included.';
  }
  return {
    userProfile: JSON.stringify(personalContext),
    counterpartProfile: JSON.stringify({
      alias: counterpart.alias, channel: counterpart.channel, appProfile: counterpart.appProfile, offlineScene: counterpart.offlineScene, background: counterpart.background, previousRounds: counterpart.rounds,
      ...(meeting === undefined ? {} : { meeting: parse(MeetingInputSchema, meeting, 'INVALID_MEETING') }),
      ...(meetingBoundary === undefined ? {} : {
        manualMeetingBoundary: meetingBoundary,
        manualMeetingRule: 'The meeting fields are a user-recorded arrangement or cancellation. Messages listed in messageIdsAtSave predate that save and cannot overwrite it. Only new conversation evidence after this boundary may update the arrangement. If messageIdsAtSave is null, the save boundary is unknown; do not treat existing chat as newer evidence. A recorded arrangement is not consent to intimacy and does not erase expressed personal boundaries.',
      }),
      recordedContext: { scope: 'all_supplied_messages_in_recorded_order', messageCount: messages.length, firstMessageId: messages[0]?.id ?? null, lastMessageId: messages.at(-1)?.id ?? null, completeWechatHistoryVerified: false, missingBackground: counterpart.background ? [] : ['relationship_background'] },
      interpretationRule: 'Assess both full profiles, how the pair met and all supplied messages together. Revisit earlier approaches, the counterpart response, subsequent handling, boundaries and later changes across complete topics. Distinguish an observed change from contradictory or missing evidence. Recent text does not erase earlier relevant evidence; a single laugh or emoji cannot establish a global decline. Do not assume that unsupplied messages or unrecorded warming attempts occurred. Timing sources remain estimates or user reports; compare the known pattern without treating a lone delay as the relationship state.',
      unknownsRule: 'Absent information is unknown, not zero interest or refusal. A recorded meeting is user reported; respect its current state and do not repeat a confirmed invitation.',
    }),
    messages,
    ...(topicChangeRequested === true ? { topicChangeRequested: true } : {}),
    ...(intent === undefined || intent === '' ? {} : { intent: parse(requiredText(2_000), intent, 'INVALID_INTENT') }),
  };
}

export const HEAT_RULE_VERSION = 'provisional-five-dimensions-3';
const HEAT_DIMENSIONS = Object.freeze(['activeInteraction', 'responseEngagement', 'personalInterest', 'reciprocalFlirting', 'actionFollowThrough']);
const LEVEL_VALUE = Object.freeze({ negative: -1, passive: 0, positive: 1, repeated_positive: 2 });
const DimensionSchema = z.strictObject({ level: z.enum(['unknown', ...Object.keys(LEVEL_VALUE)]), evidenceIds: z.array(requiredText(128)) });
const HeatClassificationSchema = z.object({
  confidence: z.enum(['limited', 'moderate', 'strong']),
  obstacle: z.object({ type: z.enum(['none', 'benign', 'negative', 'ambiguous']) }),
  heat: z.strictObject(Object.fromEntries(HEAT_DIMENSIONS.map((name) => [name, DimensionSchema]))),
});

function scoreDimensions(dimensions, names) {
  if (names.length === 0) return null;
  const total = names.reduce((sum, name) => sum + LEVEL_VALUE[dimensions[name].level], 0);
  return Math.round(((total / names.length + 1) / 3) * 100);
}

function heatTrend(current, history) {
  // A sparse latest observation cannot overwrite the last evidenced baseline.
  const previous = history.map((entry) => entry?.heat ?? entry).findLast((entry) => entry?.dimensions && entry.status !== 'insufficient_evidence' && (!Array.isArray(entry.evidenceIds) || entry.evidenceIds.length >= 2));
  if (!previous?.dimensions) return { status: 'unknown', comparableDimensions: [], delta: null };
  const names = HEAT_DIMENSIONS.filter((name) => current[name].level !== 'unknown' && Object.hasOwn(LEVEL_VALUE, previous.dimensions[name]?.level));
  if (names.length < 2) return { status: 'unknown', comparableDimensions: names, delta: null };
  const delta = scoreDimensions(current, names) - scoreDimensions(previous.dimensions, names);
  return { status: delta >= 10 ? 'rising' : delta <= -10 ? 'falling' : 'stable', comparableDimensions: names, delta };
}

function preliminaryRange(score, dimensions, evidenceIds, history, messageIds) {
  const make = (lower, upper, label, basis, ids) => ({ lower, upper, label, basis, evidenceIds: [...ids], provisional: true });
  if (score !== null) return make(Math.max(0, score - 15), Math.min(100, score + 15), '综合初判', 'observed_dimensions', evidenceIds);
  // A sparse last turn cannot erase a sufficiently evidenced full-history
  // baseline. Propagated ranges retain that baseline across several sparse turns.
  for (const entry of history.map((item) => item?.heat ?? item).reverse()) {
    if (entry?.status === 'pause') break;
    const supportedIds = Array.isArray(entry?.evidenceIds) ? entry.evidenceIds : [];
    if (entry?.status !== 'insufficient_evidence' && Number.isFinite(entry?.score) && entry.score >= 0 && entry.score <= 100 && entry.coverage >= .4 && new Set(supportedIds).size >= 2 && (!messageIds || supportedIds.every((id) => messageIds.has(id)))) {
      return make(Math.max(0, entry.score - 15), Math.min(100, entry.score + 15), '参考此前互动', 'historical_baseline', supportedIds);
    }
    const previous = entry?.preliminaryRange;
    if (previous?.basis === 'historical_baseline' && previous.provisional === true && Number.isFinite(previous.lower) && Number.isFinite(previous.upper) && previous.lower >= 0 && previous.upper <= 100 && previous.lower <= previous.upper && Array.isArray(previous.evidenceIds) && new Set(previous.evidenceIds).size >= 2 && (!messageIds || previous.evidenceIds.every((id) => messageIds.has(id)))) {
      return make(previous.lower, previous.upper, '参考此前互动', 'historical_baseline', previous.evidenceIds);
    }
  }
  if (!evidenceIds.length) return null;
  const names = HEAT_DIMENSIONS.filter((name) => dimensions[name].level !== 'unknown');
  return scoreDimensions(dimensions, names) > 33
    ? make(35, 75, '积极互动', 'observed_dimensions', evidenceIds)
    : make(10, 45, '偏低投入', 'observed_dimensions', evidenceIds);
}

export function heatContextsCompatible(previous, current) {
  // Only appended turns may extend an old observation. Editing an earlier
  // message, annotation, time, either profile or meeting invalidates that basis.
  try {
    const counterpart = (encoded) => {
      const value = JSON.parse(encoded);
      if (value.recordedContext) {
        const { messageCount, firstMessageId, lastMessageId, ...scope } = value.recordedContext;
        value.recordedContext = scope;
      }
      return value;
    };
    return Array.isArray(previous?.messages) && Array.isArray(current?.messages)
      && previous.messages.length <= current.messages.length
      && isDeepStrictEqual(JSON.parse(previous.userProfile), JSON.parse(current.userProfile))
      && isDeepStrictEqual(counterpart(previous.counterpartProfile), counterpart(current.counterpartProfile))
      && (previous.intent ?? '') === (current.intent ?? '')
      && previous.messages.every((message, index) => isDeepStrictEqual(message, current.messages[index]));
  } catch { return false; }
}

export function computeHeat(classification, { history = [], observedAt, context } = {}) {
  if (!Array.isArray(history)) throw new DomainError('INVALID_HEAT_HISTORY');
  const messageIds = context === undefined ? null : new Set(parse(z.array(MessageSchema), context?.messages, 'INVALID_HEAT_CONTEXT').map(({ id }) => id));
  const empty = Object.fromEntries(HEAT_DIMENSIONS.map((name) => [name, { level: 'unknown', evidenceIds: [] }]));
  const current = classification === null || classification === undefined ? { confidence: 'limited', obstacle: { type: 'none' }, heat: empty } : parse(HeatClassificationSchema, classification, 'INVALID_CLASSIFICATION');
  const dimensions = current.heat;
  for (const dimension of Object.values(dimensions)) {
    if (dimension.level === 'unknown' && dimension.evidenceIds.length !== 0) throw new DomainError('INVALID_CLASSIFICATION');
    if (dimension.level !== 'unknown' && dimension.evidenceIds.length === 0) throw new DomainError('INVALID_CLASSIFICATION');
    if (new Set(dimension.evidenceIds).size !== dimension.evidenceIds.length) throw new DomainError('INVALID_CLASSIFICATION');
    if (messageIds && dimension.evidenceIds.some((id) => !messageIds.has(id))) throw new DomainError('INVALID_CLASSIFICATION');
  }
  const knownNames = HEAT_DIMENSIONS.filter((name) => dimensions[name].level !== 'unknown');
  const evidenceIds = [...new Set(knownNames.flatMap((name) => dimensions[name].evidenceIds))].sort();
  const coverage = knownNames.length / HEAT_DIMENSIONS.length;
  const sufficientEvidence = coverage >= 0.4 && evidenceIds.length >= 2;
  const score = sufficientEvidence ? scoreDimensions(dimensions, knownNames) : null;
  const positive = (name) => ['positive', 'repeated_positive'].includes(dimensions[name].level);
  const positiveCount = knownNames.filter(positive).length;
  const negativeCount = knownNames.filter((name) => dimensions[name].level === 'negative').length;
  let status = 'potential';
  let explanation = '已有一些互动证据，适合结合当前状态继续建设；不要求每轮升温。';
  if (current.obstacle.type === 'negative') {
    status = 'pause'; explanation = '已观察到明确负面阻力，先停止相关推进；综合分数不能覆盖拒绝。';
  } else if (!sufficientEvidence) {
    status = 'insufficient_evidence'; explanation = '先依据现有线索做初步判断；还不清楚的部分，在自然交流中获得更多信息后再调整。';
  } else if (current.confidence !== 'limited' && coverage >= 0.6 && evidenceIds.length >= 3 && score >= 65 && positive('personalInterest') && (positive('reciprocalFlirting') || positive('actionFollowThrough')) && (positive('activeInteraction') || positive('responseEngagement')) && current.obstacle.type !== 'ambiguous') {
    status = 'high_invite'; explanation = '多个维度出现积极且有覆盖的证据，可以考虑一个可拒绝的具体邀约；仍需双方确认。';
  } else if (current.confidence !== 'limited' && coverage >= 0.6 && evidenceIds.length >= 3 && positiveCount === 0 && (negativeCount >= 2 || (knownNames.length >= 4 && evidenceIds.length >= 4))) {
    status = 'too_low'; explanation = '多个维度持续缺少积极反馈，建议暂停投入并等待真实变化；这不等于已知对方永远无兴趣。';
  }
  return {
    ruleVersion: HEAT_RULE_VERSION,
    status, score, coverage, confidence: current.confidence, dimensions, evidenceIds,
    preliminaryRange: status === 'pause' || classification === null || classification === undefined ? null : preliminaryRange(score, dimensions, evidenceIds, history, messageIds),
    trend: sufficientEvidence ? heatTrend(dimensions, history) : { status: 'unknown', comparableDimensions: [], delta: null }, provisional: true,
    scoreMeaning: 'Ordinal observed-interaction index, not a success probability; unknown dimensions excluded. Preliminary ranges are uncalibrated working estimates, not statistical confidence intervals or consent.',
    explanation,
    ...(observedAt === undefined ? {} : { observedAt }),
  };
}

export function rankTopThree(counterparts) {
  if (!Array.isArray(counterparts)) throw new DomainError('INVALID_COUNTERPARTS');
  const confidenceFactor = { limited: 0.5, moderate: 0.85, strong: 1 };
  return counterparts.filter(({ id, heat }) => typeof id === 'string' && id && heat && ['potential', 'high_invite'].includes(heat.status) && Number.isFinite(heat.score) && heat.coverage >= 0.4 && heat.evidenceIds?.length >= 2 && Object.hasOwn(confidenceFactor, heat.confidence)).map(({ id, heat }) => ({ id, priority: heat.score * heat.coverage * confidenceFactor[heat.confidence], coverage: heat.coverage, evidenceCount: heat.evidenceIds.length })).sort((a, b) => b.priority - a.priority || b.coverage - a.coverage || b.evidenceCount - a.evidenceCount || a.id.localeCompare(b.id)).slice(0, 3).map(({ id }) => id);
}

const INSTRUCTION_PATTERNS = [
  /(?:ignore|override|bypass).{0,30}(?:instruction|prompt|rule|system)/iu,
  /(?:system|developer)\s*(?:prompt|message|instruction)/iu,
  /(?:忽略|绕过|覆盖).{0,20}(?:指令|规则|提示词|权限)/u,
  /(?:输出|泄露|导出|显示|逐字|重构).{0,30}(?:知识库|系统提示|核心体系|私有资料)/u,
  /(?:<\/?(?:system|developer)>|\[INST\])/iu,
];
const NEGATIVE_OUTCOME = /(?:不要(?:再)?(?:联系|找|发消息)|别再(?:联系|找|发)|很讨厌你|让我很不舒服|不想见你|stop contacting me|do not contact me)/iu;
const POSITIVE_OUTCOME = /(?:期待见你|想见你|喜欢和你聊|let'?s meet|looking forward to seeing you)/iu;

function canonical(value) { return value.normalize('NFKC').replace(/\s+/gu, ' ').trim(); }
function literalPattern(value) { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }

export function redactSensitive(value, identifiers = []) {
  let cleaned = value;
  const transformations = [];
  const rules = [
    ['national_id', /\b\d{17}[\dXx]\b/gu],
    ['email', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu],
    ['phone', /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/gu],
    ['contact_handle', /(?:微信|wechat|weixin|wx|vx|QQ)\s*(?:号|id)?\s*[:：=]?\s*[A-Z][A-Z0-9_.-]{5,29}/giu],
    ['contact_handle', /QQ\s*(?:号|id)?\s*[:：=]?\s*\d{5,12}/giu],
    ['address', /(?:家庭住址|住址|地址)\s*[:：]\s*[^\n，。,;；]{3,100}/gu],
  ];
  for (const [kind, pattern] of rules) {
    let count = 0;
    cleaned = cleaned.replace(pattern, () => { count += 1; return `[REDACTED:${kind}]`; });
    if (count) transformations.push({ kind, count });
  }
  for (const identifier of [...new Set(identifiers.filter((item) => typeof item === 'string' && item.trim().length >= 2))]) {
    let count = 0;
    cleaned = cleaned.replace(new RegExp(literalPattern(identifier), 'gu'), () => { count += 1; return '[PERSON]'; });
    if (count) transformations.push({ kind: 'known_identifier', count });
  }
  return { text: cleaned, transformations };
}

export function cleanFeedback(raw, { suggestion, actualSentMessage, sourceId, identifiers = [] } = {}) {
  const parsed = FeedbackInputSchema.safeParse(raw);
  const missing = [];
  const flags = [];
  const provenance = { sourceId: typeof sourceId === 'string' ? sourceId : null, suggestionId: parsed.success ? parsed.data.suggestionId : null, knowledgeHash: suggestion?.knowledgeHash ?? null, actualSentMessageId: actualSentMessage?.id ?? null, actualSend: 'unconfirmed', outcomeSource: 'user_reported' };
  if (!parsed.success) return { stage: 'quarantined', dedupKey: null, cleaned: null, provenance, transformations: [], flags: ['invalid_schema'], missing: [], consent: false, allowedPurposes: [], cleanerVersion: 'deterministic-feedback-1' };
  const input = parsed.data;
  if (!sourceId) missing.push('source_id');
  if (!suggestion?.id) missing.push('suggestion_record');
  else if (suggestion.id !== input.suggestionId) flags.push('suggestion_identity_mismatch');
  if (typeof suggestion?.knowledgeHash !== 'string' || !suggestion.knowledgeHash) missing.push('knowledge_version');
  if (!input.actualSentText) missing.push('actual_sent_text');
  if (!actualSentMessage?.id) missing.push('actual_sent_record');
  else if (actualSentMessage.speaker !== 'self' || actualSentMessage.suggestionId !== input.suggestionId || typeof actualSentMessage.text !== 'string' || actualSentMessage.text.trim() !== input.actualSentText) flags.push('actual_sent_record_mismatch');
  else if (actualSentMessage.provenance !== 'user_confirmed_record') flags.push('actual_sent_record_unconfirmed');
  else provenance.actualSend = 'user_confirmed_record';
  if (!input.counterpartReply && !input.observation) missing.push('observed_outcome');
  if (input.kind !== 'uncertain' && !input.counterpartReply) missing.push('observed_counterpart_reply');
  const untrustedTexts = [input.actualSentText, input.counterpartReply, input.observation, typeof suggestion?.reply === 'string' ? suggestion.reply : ''];
  if (untrustedTexts.some((value) => INSTRUCTION_PATTERNS.some((pattern) => pattern.test(value)))) flags.push('embedded_instruction');
  if ((input.kind === 'positive' && NEGATIVE_OUTCOME.test(input.counterpartReply)) || (input.kind === 'pitfall' && POSITIVE_OUTCOME.test(input.counterpartReply))) flags.push('outcome_label_conflict');
  const originalCleanable = { kind: input.kind, suggestedReply: typeof suggestion?.reply === 'string' ? suggestion.reply : '', actualSentText: input.actualSentText, counterpartReply: input.counterpartReply, observation: input.observation };
  const transformations = [];
  const cleaned = Object.fromEntries(Object.entries(originalCleanable).map(([field, value]) => {
    const result = redactSensitive(value, identifiers);
    transformations.push(...result.transformations.map((transformation) => ({ field, ...transformation })));
    return [field, result.text];
  }));
  // Changing a label or interpretation does not create a second observed interaction.
  const dedupKey = createHash('sha256').update(JSON.stringify({ actualSentText: canonical(input.actualSentText), counterpartReply: canonical(input.counterpartReply) })).digest('hex');
  const stage = flags.length || missing.length ? 'quarantined' : 'clean_candidate';
  return { stage, dedupKey, cleaned, provenance, transformations, flags, missing, consent: input.consent, allowedPurposes: stage === 'clean_candidate' && input.consent ? ['knowledge', 'evaluation'] : [], cleanerVersion: 'deterministic-feedback-1' };
}

export function reviewFeedback(candidate, reviewInput) {
  const review = parse(ReviewInputSchema, reviewInput, 'INVALID_FEEDBACK_REVIEW');
  if (!candidate || !['clean_candidate', 'quarantined'].includes(candidate.stage)) throw new DomainError('FEEDBACK_NOT_CLEANED');
  if (review.decision === 'approve') {
    if (candidate.stage !== 'clean_candidate' || candidate.flags?.length || candidate.missing?.length || !candidate.cleaned) throw new DomainError('FEEDBACK_QUARANTINED');
    if (!candidate.consent || !candidate.allowedPurposes?.includes(review.purpose)) throw new DomainError('FEEDBACK_CONSENT_REQUIRED');
    if ([review.conditions, review.limits, review.note].some((value) => INSTRUCTION_PATTERNS.some((pattern) => pattern.test(value)))) throw new DomainError('FEEDBACK_REVIEW_UNSAFE');
  }
  const reviewTransformations = [];
  const safeReview = { ...review };
  for (const field of ['conditions', 'limits', 'note']) {
    const result = redactSensitive(safeReview[field]);
    safeReview[field] = result.text;
    reviewTransformations.push(...result.transformations.map((transformation) => ({ field, ...transformation })));
  }
  return { stage: review.decision === 'approve' ? 'approved_candidate' : 'rejected', purpose: review.purpose, dedupKey: candidate.dedupKey, cleaned: candidate.cleaned, provenance: candidate.provenance, review: safeReview, reviewTransformations, automaticKnowledgeWrite: false, modelParameterTraining: false };
}

const ApprovedCandidateSchema = z.object({
  stage: z.literal('approved_candidate'),
  purpose: z.literal('knowledge'),
  dedupKey: z.string().regex(/^[a-f0-9]{64}$/u),
  cleaned: z.strictObject({ kind: z.enum(['positive', 'pitfall', 'uncertain']), suggestedReply: text(5_000), actualSentText: requiredText(5_000), counterpartReply: text(5_000), observation: text(5_000) }),
  provenance: z.object({ sourceId: requiredText(128), suggestionId: requiredText(128), knowledgeHash: requiredText(128), actualSentMessageId: requiredText(128), actualSend: z.literal('user_confirmed_record'), outcomeSource: z.literal('user_reported') }),
  review: ReviewInputSchema,
});

export function buildFeedbackKnowledgeSupplement(approvedInput, { identifiers = [] } = {}) {
  const approved = parse(ApprovedCandidateSchema, approvedInput, 'INVALID_APPROVED_FEEDBACK');
  if (approved.review.decision !== 'approve' || approved.review.purpose !== 'knowledge') throw new DomainError('INVALID_APPROVED_FEEDBACK');
  const safe = { ...approved, cleaned: { ...approved.cleaned }, review: { ...approved.review } };
  for (const section of ['cleaned', 'review']) {
    const fields = section === 'cleaned' ? ['suggestedReply', 'actualSentText', 'counterpartReply', 'observation'] : ['conditions', 'limits', 'note'];
    for (const field of fields) {
      const value = safe[section][field];
      if (INSTRUCTION_PATTERNS.some((pattern) => pattern.test(value))) throw new DomainError('FEEDBACK_REVIEW_UNSAFE');
      safe[section][field] = redactSensitive(value, identifiers).text;
    }
  }
  return `## Reviewed feedback candidate\n\nThis is one user-reported observation, scoped by the owner's conditions and limits. It is not proof of causation or a universal rule. Manual sending is a user-confirmed record, not verified platform delivery.\n\n\`\`\`json\n${JSON.stringify(safe, null, 2)}\n\`\`\`\n`;
}
