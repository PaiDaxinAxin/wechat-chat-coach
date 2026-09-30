import { z } from 'zod';
import { ChatMessageSchema } from './chat-record.mjs';

const shortText = (maximum) => z.string().trim().min(1).max(maximum);
const evidenceIds = z.array(shortText(120)).max(30);

// This module has no static dependency on coach: coach uses this schema while
// the manual plan path loads the shared provider helper only when called.
export const FIELD_COACH_SCHEMA = z.strictObject({
  currentTopic: shortText(120),
  topicStatus: z.enum(['developing', 'repetitive', 'closing', 'unknown']),
  topicMessageIds: evidenceIds,
  initiative: shortText(200),
  nextAction: shortText(200),
  warmingLayer: z.enum(['A', 'B', 'C', 'none']),
  reason: shortText(200),
});

export const FIELD_COACH_PLAN_SCHEMA = z.strictObject({
  verdict: z.enum(['suitable', 'adjust', 'wait', 'needs_context']),
  reason: shortText(300),
  timingSuggestion: z.strictObject({
    status: z.enum(['now', 'after_response', 'after_topic', 'wait', 'unknown']),
    guidance: shortText(200),
    evidenceIds,
  }),
  adjustedPlan: shortText(1_000).optional(),
  nextAction: shortText(300),
});

const FIELD_PLAN_TASK = `你是本轮的场外教练，评估用户提出的计划是否合适、何时做、需要什么条件，以及如何依据对方后续调整。输出是给用户看的计划判断，不是发给对方的微信回复；不得输出 reply 或声称已发送、已收到、已执行。
双方完整画像与完整知识都作为背景；context.messages 中的 provenance、录入时间、用户报告时间和 replyInterval 必须保留其来源与不确定性。inferred_from_followup 只是关联草稿，不能当作实际已发送，也不能作为对方接受该草稿的证明。应用估计间隔不是真实微信延迟，用户报告时间也不是平台验证；慢回或未解释忙碌不能单独推导拒绝。
一轮是一个完整话题，不是一次来回。10–20句是检查话题是否重复、无聊、需要转换的经验检查点，不是硬换题阈值。主动主导与回应兼顾；靠近→张力或留白→观察回应，约三四个完整话题后的留白也是待校准经验，不能按消息条数设倒计时。
升温层级与上切/下切/平移话题方向独立。A是浅而具体的评价或定义，例如你好看、你不错、你是什么样的人，可主动轻度尝试，不必先等积极信号。B是男对女的两性身份或约会意味框架，不等于单纯邀约。C是明显私密暗示，例如来我家床上坐或猫后空翻的私密邀请；舒适度未知、证据有限或阻力含糊时不建议C，不把高热度、用户自己的草稿或过去了几轮当作舒适证据。
默认一个完整话题内一次升温尝试，避免同轮叠加强度；出现良性阻力，结合上下文化解再发展下一轮。不能把明确抗拒或拒绝解释为测试；停止相同升级。针对C必须有已建立相互舒适、对方接受私密框架的具体依据，否则调整为A、普通交流或澄清，不新增人工确认步骤。
timingSuggestion 用 now/after_response/after_topic/wait/unknown 表达当下、回应后、话题结束后、等待或未知，guidance 简短说明。只引用实际 context.messages 的 id；unknown 不带 evidenceIds，也不编造精确等待时长或钟点。信息不足时指出缺失条件，但不要把主动A统一推迟到积极信号之后。
verdict=adjust 必须给 adjustedPlan，其他 verdict 不给 adjustedPlan。只给当轮必要短理由与下一步，不引用私有知识原文、目录或理论摘录。通过唯一 submit_coaching_result 一次提交符合工具schema的结果。`;

const EXACT_TIME = /(?:\d+(?:\.\d+)?|[一二三四五六七八九十两半]+)\s*(?:秒钟?|分钟|个?小时|天后|周后|点钟)|(?:上午|下午|晚上|早上|凌晨|傍晚)\s*(?:\d+|[一二三四五六七八九十两]+)点|\d{1,2}:\d{2}/u;

class FieldCoachValidationError extends Error {
  constructor(code, diagnostics) {
    super(code);
    this.name = 'FieldCoachValidationError';
    this.code = code;
    if (diagnostics !== undefined) this.diagnostics = diagnostics;
  }
}

function fail(category) {
  throw new FieldCoachValidationError('invalid_model_output', [{ code: category, path: [] }]);
}

function parseOutput(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) {
    const diagnostics = result.error.issues.slice(0, 12).map(({ code, path }) => ({ code, path }));
    throw new FieldCoachValidationError('invalid_model_output', diagnostics);
  }
  return result.data;
}

function validateEvidence(ids, context) {
  const known = new Set(context.messages.map(({ id }) => id));
  if (new Set(ids).size !== ids.length) fail('duplicate_evidence');
  if (ids.some((id) => !known.has(id))) fail('invalid_evidence_reference');
}

function outputStrings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(outputStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(outputStrings);
  return [];
}

function rejectKnowledgeExcerpt(value, knowledgeText) {
  if (typeof knowledgeText !== 'string') return;
  const source = knowledgeText.replace(/\s+/gu, ' ').trim();
  // A narrow deterministic check for copied passages, including prefixed quotes.
  // This does not establish protection against semantic paraphrases or all leaks.
  for (const text of outputStrings(value)) {
    const normalized = text.replace(/\s+/gu, ' ').trim();
    for (let start = 0; start + 48 <= normalized.length; start += 1) {
      if (source.includes(normalized.slice(start, start + 48))) fail('private_knowledge_excerpt');
    }
  }
}

export function validateFieldCoachObservation(value, context, { confidence = 'limited', obstacleType = 'ambiguous', knowledgeText } = {}) {
  // The classification caller already validates its full ChatInputSchema. This
  // pure helper validates the message contract needed for evidence coverage.
  const messages = z.array(ChatMessageSchema).safeParse(context?.messages);
  if (!messages.success || new Set(messages.data.map(({ id }) => id)).size !== messages.data.length) throw new FieldCoachValidationError('invalid_input');
  const parsedContext = { messages: messages.data };
  const result = parseOutput(FIELD_COACH_SCHEMA, value);
  validateEvidence(result.topicMessageIds, parsedContext);
  if (result.topicStatus === 'unknown' && result.topicMessageIds.length !== 0) fail('unknown_topic_with_evidence');
  if (result.topicStatus === 'unknown' && result.currentTopic !== '未知') fail('unknown_topic_with_asserted_label');
  if (result.topicStatus !== 'unknown' && result.topicMessageIds.length === 0) fail('observed_topic_without_evidence');
  if (obstacleType === 'negative' && result.warmingLayer !== 'none') fail('refusal_with_warming');
  if (result.warmingLayer === 'C') {
    const observedOther = parsedContext.messages.some((message) => result.topicMessageIds.includes(message.id) && message.speaker === 'other' && message.provenance !== 'inferred_from_followup');
    if (!['moderate', 'strong'].includes(confidence) || !['none', 'benign'].includes(obstacleType) || result.topicStatus === 'unknown' || !observedOther) fail('unsupported_private_warming');
  }
  rejectKnowledgeExcerpt(result, knowledgeText);
  return result;
}

export async function generateFieldCoachPlan(input, options = {}) {
  const { ChatInputSchema, CoachError, runCoachTask } = await import('./coach.mjs');
  const parsedInput = z.strictObject({ context: ChatInputSchema, plan: shortText(2_000) }).safeParse(input);
  if (!parsedInput.success) throw new CoachError('invalid_input');
  const value = await runCoachTask(FIELD_PLAN_TASK, parsedInput.data, FIELD_COACH_PLAN_SCHEMA, options, 1_500);
  try {
    const result = parseOutput(FIELD_COACH_PLAN_SCHEMA, value);
    validateEvidence(result.timingSuggestion.evidenceIds, parsedInput.data.context);
    if (result.timingSuggestion.status === 'unknown') {
      if (result.timingSuggestion.evidenceIds.length !== 0) fail('unknown_timing_with_evidence');
      // Unknown future timing does not prohibit describing an observed past interval.
      // Only the timing guidance has this narrow precision restriction.
      if (EXACT_TIME.test(result.timingSuggestion.guidance)) fail('unknown_timing_with_precision');
    }
    if (result.verdict === 'needs_context' && result.timingSuggestion.status !== 'unknown') fail('missing_context_with_asserted_timing');
    if (result.verdict === 'adjust' && !result.adjustedPlan) fail('adjusted_plan_required');
    if (result.verdict !== 'adjust' && result.adjustedPlan !== undefined) fail('unexpected_adjusted_plan');
    rejectKnowledgeExcerpt(result, options.knowledgeText);
    return result;
  } catch (error) {
    if (error instanceof FieldCoachValidationError) throw new CoachError(error.code, undefined, error.diagnostics);
    throw error;
  }
}
