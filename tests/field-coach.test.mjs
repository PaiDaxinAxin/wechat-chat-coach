import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { FIELD_COACH_SCHEMA, FIELD_COACH_PLAN_SCHEMA, generateFieldCoachPlan, validateFieldCoachObservation } from '../src/field-coach.mjs';

const env = { AGNES_API_KEY: 'mock-field-key', AGNES_MODEL: 'configured-test-model', AGNES_BASE_URL: 'http://127.0.0.1:9999/v1' };
const knowledgeText = ' 完整知识开头\n不可压缩的虚构知识用于机械验证。\n'.repeat(1_000) + '\n独特秘密片段甲乙丙丁戊己庚辛壬癸甲乙丙丁戊己庚辛壬癸甲乙丙丁戊己庚辛壬癸甲乙丙丁戊己庚辛壬癸甲乙丙丁戊己庚辛壬癸。\n';
const context = {
  userProfile: '虚构用户当前风格简短，成长目标主动主导。完整问卷答案保留在这里。',
  counterpartProfile: '虚构对象，线下认识，交往背景尚有限。',
  messages: [
    { id: 'self-draft', speaker: 'self', text: '你今天状态不错。', provenance: 'inferred_from_followup', recordedAt: '2026-10-01T10:00:00.000Z' },
    { id: 'other-next', speaker: 'other', text: '哈哈，今天确实心情好。', provenance: 'user_entered', recordedAt: '2026-10-01T10:03:00.000Z', wechatTime: { at: '2026-10-01T10:02:00.000Z', source: 'user_reported', editedAt: '2026-10-01T10:03:00.000Z' }, replyInterval: { fromAt: '2026-10-01T10:00:00.000Z', toAt: '2026-10-01T10:03:00.000Z', elapsedMs: 180_000, fromSource: 'suggestion_prepared', toSource: 'counterpart_text_recorded', reliability: 'weak_preparation_estimate', interpretation: 'not_verified_wechat_latency' } },
  ],
};
const input = { context, plan: '我想先聊她今天心情不错的原因，再轻度评价一次。' };
const goodPlan = () => ({ verdict: 'suitable', reason: '先承接她主动表达的心情，再轻度评价，避免连续推进。', timingSuggestion: { status: 'now', guidance: '顺着当前话题主动展开，并观察她如何接话。', evidenceIds: ['other-next'] }, nextAction: '先了解今天发生了什么，再决定是否留白。' });
const goodObservation = () => ({ currentTopic: '今天心情不错', topicStatus: 'developing', topicMessageIds: ['other-next'], initiative: '主动了解具体发生了什么。', nextAction: '轻度评价后观察她的回应。', warmingLayer: 'A', reason: 'A可以主动尝试，无需把对方积极信号设为前置门槛。' });

function response(value, { calls, raw, finishReason = 'tool_calls' } = {}) {
  return { ok: true, json: async () => ({ choices: [{ finish_reason: finishReason, message: { tool_calls: calls ?? [{ type: 'function', function: { name: 'submit_coaching_result', arguments: raw ?? JSON.stringify(value) } }] } }] }) };
}
const mocked = (value, extra) => async () => response(value, extra);
const options = (value, extra) => ({ env, knowledgeText, fetchImpl: mocked(value, extra) });

test('plan uses the shared native provider path, exact full knowledge and complete provenance/timing input', async () => {
  let calls = 0;
  const fetchImpl = async (url, request) => {
    calls += 1;
    assert.equal(url, 'http://127.0.0.1:9999/v1/chat/completions');
    assert.equal(request.headers.Authorization, 'Bearer mock-field-key');
    const body = JSON.parse(request.body);
    assert.equal(body.model, env.AGNES_MODEL);
    assert.equal(body.messages[1].content, knowledgeText);
    const serialized = body.messages[2].content.split('本轮输入数据：\n')[1];
    assert.deepEqual(JSON.parse(serialized), input);
    assert.match(body.messages[2].content, /一轮是一个完整话题，不是一次来回/);
    assert.match(body.messages[2].content, /不必先等积极信号/);
    assert.match(body.messages[2].content, /不是发给对方的微信回复/);
    assert.equal(body.tools.length, 1);
    assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'submit_coaching_result' } });
    assert.equal(body.parallel_tool_calls, false);
    const schema = body.tools[0].function.parameters;
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.timingSuggestion.additionalProperties, false);
    assert.equal(Object.hasOwn(schema.properties, 'reply'), false);
    assert.equal(schema.properties.adjustedPlan.maxLength, 1_000);
    assert.equal(body.max_tokens, 1_500);
    return response(goodPlan());
  };
  assert.deepEqual(await generateFieldCoachPlan(input, { env, knowledgeText, fetchImpl }), goodPlan());
  assert.equal(calls, 1);
});

test('invalid plan/context input, missing KB and key fail before any model call', async () => {
  let calls = 0;
  const fetchImpl = () => { calls += 1; throw new Error('must not call'); };
  for (const bad of [{ ...input, plan: '' }, { ...input, plan: '长'.repeat(2_001) }, { ...input, account: 'owner' }, { ...input, context: { ...context, messages: [context.messages[0], context.messages[0]] } }]) {
    await assert.rejects(generateFieldCoachPlan(bad, { env, knowledgeText, fetchImpl }), { code: 'invalid_input' });
  }
  await assert.rejects(generateFieldCoachPlan(input, { env, knowledgeText: ' ', fetchImpl }), { code: 'missing_knowledge' });
  await assert.rejects(generateFieldCoachPlan(input, { env: {}, knowledgeText, fetchImpl }), { code: 'missing_api_key' });
  assert.equal(calls, 0);
});

test('native result accepts only one expected submission and never retries or executes a model tool', async (t) => {
  const validCall = { type: 'function', function: { name: 'submit_coaching_result', arguments: JSON.stringify(goodPlan()) } };
  for (const [name, extra, code] of [
    ['missing submission', { calls: [] }, 'missing_model_tool_call'],
    ['multiple submissions', { calls: [validCall, validCall] }, 'multiple_model_tool_calls'],
    ['unexpected tool', { calls: [{ ...validCall, function: { ...validCall.function, name: 'send_wechat_message' } }] }, 'unexpected_model_tool_call'],
    ['malformed arguments', { raw: '```json {} ```' }, 'invalid_model_json'],
    ['truncated response', { finishReason: 'length' }, 'truncated_model_output'],
  ]) {
    await t.test(name, async () => {
      let calls = 0;
      await assert.rejects(generateFieldCoachPlan(input, { env, knowledgeText, fetchImpl: async () => { calls += 1; return response(goodPlan(), extra); } }), { code });
      assert.equal(calls, 1);
    });
  }
});

test('plan results have bounded strict fields and cannot become a chat reply or hide raw source in extra keys', async () => {
  for (const bad of [{ ...goodPlan(), reply: '发给对方的话。' }, { ...goodPlan(), reason: '长'.repeat(301) }, { ...goodPlan(), adjustedPlan: '改变计划。' }, { ...goodPlan(), verdict: 'adjust' }]) {
    await assert.rejects(generateFieldCoachPlan(input, options(bad)), { code: 'invalid_model_output' });
  }
  const adjusted = { ...goodPlan(), verdict: 'adjust', adjustedPlan: '先保持轻度话题，把私密邀请延后到已建立舒适度时。' };
  assert.deepEqual(await generateFieldCoachPlan(input, options(adjusted)), adjusted);
  assert.equal(FIELD_COACH_PLAN_SCHEMA.safeParse({ ...goodPlan(), secret: knowledgeText }).success, false);
});

test('timing evidence must be actual, unique and unknown cannot manufacture precision', async () => {
  const unknown = { verdict: 'needs_context', reason: '不知道这次沟通是否仍在同一话题。', timingSuggestion: { status: 'unknown', guidance: '先了解当前话题状态，避免推定实际回复耗时。', evidenceIds: [] }, nextAction: '结合对方下一句决定是否展开。' };
  assert.deepEqual(await generateFieldCoachPlan(input, options(unknown)), unknown);
  const uncertain = { ...unknown, reason: '信息还少一点，暂时无法确定时机。' };
  assert.deepEqual(await generateFieldCoachPlan(input, options(uncertain)), uncertain);
  const observedHour = { ...unknown, reason: '本次应用估计间隔一小时才录入后续，但是否现在推进还不确定。' };
  const pastIntervalInput = { ...input, context: { ...context, messages: context.messages.map((message) => message.id === 'other-next' ? { ...message, recordedAt: '2026-10-01T11:00:00.000Z', wechatTime: null, replyInterval: { ...message.replyInterval, toAt: '2026-10-01T11:00:00.000Z', elapsedMs: 3_600_000 } } : message) } };
  assert.deepEqual(await generateFieldCoachPlan(pastIntervalInput, options(observedHour)), observedHour);
  for (const bad of [
    { ...goodPlan(), timingSuggestion: { ...goodPlan().timingSuggestion, evidenceIds: ['invented'] } },
    { ...goodPlan(), timingSuggestion: { ...goodPlan().timingSuggestion, evidenceIds: ['other-next', 'other-next'] } },
    { ...unknown, timingSuggestion: { ...unknown.timingSuggestion, evidenceIds: ['other-next'] } },
    { ...unknown, timingSuggestion: { ...unknown.timingSuggestion, guidance: '等15分钟再回复。' } },
    { ...unknown, timingSuggestion: { ...unknown.timingSuggestion, guidance: '下午三点再推进。' } },
    { ...unknown, timingSuggestion: { ...unknown.timingSuggestion, status: 'now' } },
  ]) await assert.rejects(generateFieldCoachPlan(input, options(bad)), { code: 'invalid_model_output' });
});

test('exact KB passages are rejected even inside a bounded allowed field and prefixed quote', async () => {
  const excerpt = knowledgeText.split('\n').find((line) => line.startsWith('独特秘密片段'));
  await assert.rejects(generateFieldCoachPlan(input, options({ ...goodPlan(), reason: `根据私有资料：${excerpt}` })), (error) => {
    assert.equal(error.code, 'invalid_model_output');
    assert.deepEqual(error.diagnostics, [{ code: 'private_knowledge_excerpt', path: [] }]);
    assert.doesNotMatch(JSON.stringify(error), /独特秘密片段/);
    return true;
  });
});

test('observation schema preserves active A without positive signal and validates actual topic evidence', () => {
  const neutralContext = { ...context, messages: [{ id: 'neutral', speaker: 'other', text: '最近忙工作。' }] };
  const activeA = { ...goodObservation(), currentTopic: '工作', topicMessageIds: ['neutral'] };
  assert.deepEqual(validateFieldCoachObservation(activeA, neutralContext), activeA);
  for (const bad of [{ ...activeA, topicMessageIds: ['invented'] }, { ...activeA, topicMessageIds: ['neutral', 'neutral'] }, { ...activeA, topicStatus: 'unknown' }, { ...activeA, topicMessageIds: [] }, { ...activeA, currentTopic: '长'.repeat(121) }, { ...activeA, rawKnowledge: knowledgeText }]) {
    assert.throws(() => validateFieldCoachObservation(bad, neutralContext), { code: 'invalid_model_output' });
  }
  const unknown = { ...goodObservation(), currentTopic: '未知', topicStatus: 'unknown', topicMessageIds: [], warmingLayer: 'none' };
  assert.deepEqual(validateFieldCoachObservation(unknown, { ...context, messages: [] }), unknown);
  assert.throws(() => validateFieldCoachObservation({ ...unknown, currentTopic: '对方的工作' }, context), { code: 'invalid_model_output' });
  for (const warmingLayer of ['A', 'B', 'C']) assert.throws(() => validateFieldCoachObservation({ ...goodObservation(), warmingLayer }, context, { confidence: 'strong', obstacleType: 'negative' }), { code: 'invalid_model_output' });
  assert.deepEqual(validateFieldCoachObservation({ ...goodObservation(), warmingLayer: 'none' }, context, { confidence: 'strong', obstacleType: 'negative' }), { ...goodObservation(), warmingLayer: 'none' });
  assert.equal(FIELD_COACH_SCHEMA.safeParse(goodObservation()).success, true);
});

test('C requires non-limited/non-ambiguous metadata and counterpart evidence, never inferred self alone', () => {
  const privateC = { ...goodObservation(), warmingLayer: 'C' };
  for (const metadata of [{}, { confidence: 'limited', obstacleType: 'none' }, { confidence: 'strong', obstacleType: 'ambiguous' }, { confidence: 'strong', obstacleType: 'negative' }]) {
    assert.throws(() => validateFieldCoachObservation(privateC, context, metadata), { code: 'invalid_model_output' });
  }
  assert.throws(() => validateFieldCoachObservation({ ...privateC, topicMessageIds: ['self-draft'] }, context, { confidence: 'strong', obstacleType: 'none' }), { code: 'invalid_model_output' });
  // This is evidence coverage only, not proof that the model interpreted comfort correctly.
  assert.deepEqual(validateFieldCoachObservation(privateC, context, { confidence: 'moderate', obstacleType: 'none' }), privateC);
});

test('provider and schema errors expose fixed categories/paths without secrets or model text', async () => {
  const secret = 'synthetic-key-never-echo';
  await assert.rejects(generateFieldCoachPlan(input, { knowledgeText, env: { AGNES_API_KEY: secret }, fetchImpl: async () => { throw new Error(`${secret}: private upstream body`); } }), (error) => error.code === 'provider_unreachable' && !JSON.stringify(error).includes(secret));
  const bad = { ...goodPlan(), verdict: 'private-invalid-model-value' };
  await assert.rejects(generateFieldCoachPlan(input, options(bad)), (error) => {
    assert.deepEqual(error.diagnostics, [{ code: 'invalid_value', path: ['verdict'] }]);
    assert.doesNotMatch(JSON.stringify(error), /private-invalid-model-value/);
    return true;
  });
});

test('both module entry orders import without network, stdout or circular initialization errors', () => {
  const coachUrl = new URL('../src/coach.mjs', import.meta.url).href;
  const fieldUrl = new URL('../src/field-coach.mjs', import.meta.url).href;
  for (const order of [[coachUrl, fieldUrl], [fieldUrl, coachUrl]]) {
    const program = `globalThis.fetch=()=>{throw new Error('import invoked fetch')}; for (const url of ${JSON.stringify(order)}) await import(url);`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8', env: { ...process.env, AGNES_API_KEY: '' } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  }
});
