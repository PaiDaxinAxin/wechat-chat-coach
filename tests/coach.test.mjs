import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatInputSchema, ReplyInputSchema, classifyChat, generateReply, CoachError } from '../src/coach.mjs';

const env = { AGNES_API_KEY: 'mock-key' };
const knowledgeText = '原始知识第一行。\n第二行完整保留。\n'.repeat(1000);
const input = {
  userProfile: '虚构用户，喜欢简洁直接。',
  counterpartProfile: '虚构对象，背景暂时有限。',
  messages: [{ id: 'm1', speaker: 'other', text: '最近忙工作，你呢？' }],
};

function validClassification() {
  const unknown = () => ({ level: 'unknown', evidenceIds: [] });
  return {
    status: 'ready', confidence: 'limited', phase: 'ordinary',
    obstacle: { type: 'none', evidenceIds: [], reason: '当前没有观察到阻力。' },
    heat: {
      activeInteraction: unknown(),
      responseEngagement: { level: 'positive', evidenceIds: ['m1'] },
      personalInterest: { level: 'positive', evidenceIds: ['m1'] },
      reciprocalFlirting: unknown(), actionFollowThrough: unknown(),
    },
    options: [
      { topicMove: 'up', relationAction: 'continue', weight: 0.5, reason: '可以了解工作的大类。', evidenceIds: ['m1'] },
      { topicMove: 'down', relationAction: 'continue', weight: 0.2, reason: '也可了解具体日常。', evidenceIds: ['m1'] },
      { topicMove: 'sideways', relationAction: 'continue', weight: 0.3, reason: '可以关联到最近状态。', evidenceIds: ['m1'] },
    ],
    uncertainties: ['仅有一条消息，不能判断持续兴趣。'], recommendationKind: 'uncalibrated',
  };
}

function mockResponse(value, options = {}) {
  return async () => ({
    ok: true,
    json: async () => ({ choices: [{
      finish_reason: options.finishReason ?? 'tool_calls',
      message: options.message ?? {
        content: null,
        tool_calls: options.calls ?? [{
          type: 'function',
          function: { name: 'submit_coaching_result', arguments: options.raw ?? JSON.stringify(value) },
        }],
      },
    }] }),
  });
}

test('classification sends the complete knowledge and known Agnes request shape', async () => {
  let calls = 0;
  const fetchImpl = async (url, request) => {
    calls += 1;
    assert.equal(url, 'https://apihub.agnes-ai.com/v1/chat/completions');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.Authorization, 'Bearer mock-key');
    const body = JSON.parse(request.body);
    assert.equal(body.messages[1].content, knowledgeText);
    assert.equal(body.model, 'agnes-3.0-flash');
    assert.equal(body.chat_template_kwargs.enable_thinking, false);
    assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'submit_coaching_result' } });
    assert.equal(body.parallel_tool_calls, false);
    assert.equal(body.tools.length, 1);
    assert.equal(body.tools[0].type, 'function');
    assert.equal(body.tools[0].function.name, 'submit_coaching_result');
    const parameters = body.tools[0].function.parameters;
    assert.equal(parameters.type, 'object');
    assert.equal(parameters.additionalProperties, false);
    assert.deepEqual(parameters.properties.status.enum, ['ready', 'needs_context']);
    assert.equal(Object.hasOwn(parameters.properties, 'reply'), false);
    assert.equal(parameters.properties.options.minItems, 3);
    assert.equal(parameters.properties.options.maxItems, 3);
    return mockResponse(validClassification())();
  };
  const result = await classifyChat(input, { knowledgeText, env, fetchImpl });
  assert.equal(result.recommendationKind, 'uncalibrated');
  assert.equal(result.heat.reciprocalFlirting.level, 'unknown');
  assert.equal(calls, 1);
});

test('input schemas reject duplicate message IDs before an API call', async () => {
  const duplicate = { ...input, messages: [input.messages[0], { ...input.messages[0] }] };
  assert.equal(ChatInputSchema.safeParse(duplicate).success, false);
  assert.equal(ReplyInputSchema.safeParse({ context: input, direction: 'invented' }).success, false);
  await assert.rejects(classifyChat(duplicate, { knowledgeText, env, fetchImpl: () => { throw new Error('must not call'); } }), { code: 'invalid_input' });
});

test('missing knowledge or credentials fail locally without a call', async () => {
  let calls = 0;
  const fetchImpl = () => { calls += 1; throw new Error('must not call'); };
  await assert.rejects(classifyChat(input, { knowledgeText: '  ', env, fetchImpl }), { code: 'missing_knowledge' });
  await assert.rejects(classifyChat(input, { knowledgeText, env: {}, fetchImpl }), { code: 'missing_api_key' });
  assert.equal(calls, 0);
});

test('malformed JSON and truncated output are rejected without retries', async () => {
  let calls = 0;
  const malformed = async () => { calls += 1; return mockResponse(null, { raw: '```json\n{}\n```' })(); };
  await assert.rejects(classifyChat(input, { knowledgeText, env, fetchImpl: malformed }), { code: 'invalid_model_json' });
  assert.equal(calls, 1);
  await assert.rejects(classifyChat(input, { knowledgeText, env, fetchImpl: mockResponse(validClassification(), { finishReason: 'length' }) }), { code: 'truncated_model_output' });
});

test('only one expected function submission is accepted; model tools are never executed', async (t) => {
  const validCall = { type: 'function', function: { name: 'submit_coaching_result', arguments: JSON.stringify(validClassification()) } };
  const cases = [
    ['plain text instead of tool submission', { message: { content: JSON.stringify(validClassification()) } }, 'missing_model_tool_call'],
    ['empty tool calls', { calls: [] }, 'missing_model_tool_call'],
    ['more than one submission', { calls: [validCall, validCall] }, 'multiple_model_tool_calls'],
    ['unexpected function name', { calls: [{ ...validCall, function: { ...validCall.function, name: 'read_private_knowledge' } }] }, 'unexpected_model_tool_call'],
    ['wrong tool type', { calls: [{ ...validCall, type: 'other' }] }, 'invalid_model_tool_call'],
    ['arguments must be a JSON string', { calls: [{ ...validCall, function: { ...validCall.function, arguments: validClassification() } }] }, 'invalid_model_tool_call'],
  ];
  for (const [name, options, code] of cases) {
    await t.test(name, async () => {
      await assert.rejects(classifyChat(input, { knowledgeText, env, fetchImpl: mockResponse(null, options) }), { code });
    });
  }
});

test('weights, direction uniqueness, evidence IDs and observed heat are strictly checked', async (t) => {
  const mutations = [
    ['weights do not add to one', (value) => { value.options[0].weight = 0.7; }],
    ['duplicate direction', (value) => { value.options[1].topicMove = 'up'; }],
    ['invented evidence', (value) => { value.options[0].evidenceIds = ['not-a-message']; }],
    ['repeated evidence', (value) => { value.options[0].evidenceIds = ['m1', 'm1']; }],
    ['unknown with fabricated observation', (value) => { value.heat.reciprocalFlirting.evidenceIds = ['m1']; }],
    ['observation without evidence', (value) => { value.heat.personalInterest.evidenceIds = []; }],
    ['extra field containing raw knowledge', (value) => { value.knowledge = knowledgeText; }],
    ['oversized reason', (value) => { value.options[0].reason = '长'.repeat(201); }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      const value = validClassification(); mutate(value);
      await assert.rejects(classifyChat(input, { knowledgeText, env, fetchImpl: mockResponse(value) }), { code: 'invalid_model_output' });
    });
  }
});

test('reply respects requested direction and allows an empty pause', async () => {
  const value = { reply: '', reason: '对方已经明确表示不想继续。', action: 'pause', styleNote: '暂时停止追问。' };
  const fetchImpl = async (_url, request) => {
    const body = JSON.parse(request.body);
    assert.equal(body.messages[1].content, knowledgeText);
    assert.match(body.messages[2].content, /"direction":"down"/);
    const parameters = body.tools[0].function.parameters;
    assert.equal(body.tools.length, 1);
    assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'submit_coaching_result' } });
    assert.equal(parameters.additionalProperties, false);
    assert.deepEqual(Object.keys(parameters.properties).sort(), ['action', 'reason', 'reply', 'styleNote']);
    assert.equal(parameters.properties.reply.maxLength, 350);
    assert.deepEqual(parameters.properties.action.enum, ['reply', 'wait', 'clarify', 'invite', 'pause']);
    return mockResponse(value)();
  };
  assert.deepEqual(await generateReply({ context: input, direction: 'down' }, { knowledgeText, env, fetchImpl }), value);
});

test('reply length limits and required reply text are validated', async () => {
  const base = { reply: '你主要忙哪一类工作？', reason: '了解工作的大类。', action: 'reply', styleNote: '保持简短自然。' };
  const cases = [{ ...base, reply: '长'.repeat(351) }, { ...base, reason: '长'.repeat(201) }, { ...base, styleNote: '长'.repeat(201) }, { ...base, reply: '' }, { ...base, raw: knowledgeText }];
  for (const value of cases) {
    await assert.rejects(generateReply({ context: input }, { knowledgeText, env, fetchImpl: mockResponse(value) }), { code: 'invalid_model_output' });
  }
  assert.deepEqual(await generateReply({ context: input }, { knowledgeText, env, fetchImpl: mockResponse(base) }), base);
});

test('provider failures reveal categories/status, never raw error bodies or keys', async () => {
  const key = 'mock-secret-never-return';
  await assert.rejects(classifyChat(input, { knowledgeText, env: { AGNES_API_KEY: key }, fetchImpl: async () => { throw new Error(key); } }), (error) => error instanceof CoachError && error.code === 'provider_unreachable' && !error.message.includes(key));
  await assert.rejects(classifyChat(input, { knowledgeText, env, fetchImpl: async () => ({ ok: false, status: 429, json: () => { throw new Error('must not read'); } }) }), { code: 'provider_http_error', status: 429 });
});

test('schema and semantic diagnostics contain only fixed categories and schema paths', async () => {
  const value = validClassification();
  value.options[0].relationAction = 'private-source-never-echo';
  await assert.rejects(classifyChat(input, { knowledgeText, env, fetchImpl: mockResponse(value) }), (error) => {
    assert.equal(error.code, 'invalid_model_output');
    assert.deepEqual(error.diagnostics, [{ code: 'invalid_value', path: ['options', 0, 'relationAction'] }]);
    assert.doesNotMatch(JSON.stringify(error), /private-source-never-echo/);
    return true;
  });
  const invalidWeights = validClassification();
  invalidWeights.options[0].weight = 0.9;
  await assert.rejects(classifyChat(input, { knowledgeText, env, fetchImpl: mockResponse(invalidWeights) }), (error) => {
    assert.deepEqual(error.diagnostics, [{ code: 'invalid_weight_sum', path: [] }]);
    return true;
  });
});

test('configured endpoint must not contain credentials or use insecure remote HTTP', async () => {
  for (const baseUrl of ['https://someone:secret@example.invalid/v1', 'http://example.invalid/v1', 'https://example.invalid/v1?key=secret']) {
    await assert.rejects(classifyChat(input, { knowledgeText, env: { ...env, AGNES_BASE_URL: baseUrl }, fetchImpl: () => { throw new Error('must not call'); } }), { code: 'invalid_configuration' });
  }
});

test('module import has no network or stdout side effects', async () => {
  const { spawnSync } = await import('node:child_process');
  const moduleUrl = new URL('../src/coach.mjs', import.meta.url).href;
  const program = `globalThis.fetch = () => { throw new Error('import invoked fetch'); }; await import(${JSON.stringify(moduleUrl)});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8', env: { ...process.env, AGNES_API_KEY: '' } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('classification retains inferred provenance and time sources and semantically validates field coaching in its single native call', async () => {
  const context = { ...input, messages: [
    { id: 'draft', speaker: 'self', text: '待发草稿。', provenance: 'inferred_from_followup', recordedAt: '2026-10-01T08:00:00.000Z', wechatTime: null, replyInterval: null },
    { ...input.messages[0], provenance: 'user_entered', recordedAt: '2026-10-01T09:00:00.000Z', wechatTime: { at: '2026-10-01T08:50:00.000Z', source: 'user_reported', editedAt: '2026-10-01T09:00:00.000Z' }, replyInterval: { fromAt: '2026-10-01T08:00:00.000Z', toAt: '2026-10-01T09:00:00.000Z', elapsedMs: 3_600_000, fromSource: 'clipboard_copied', toSource: 'counterpart_text_recorded', reliability: 'app_interval_estimate', interpretation: 'not_verified_wechat_latency' } },
  ] };
  const field = { currentTopic: '最近的工作状态', topicStatus: 'developing', topicMessageIds: ['m1'], initiative: '了解她最近的工作状态。', nextAction: '问她最近主要忙哪类工作。', pitfall: '避免连续追问多个工作细节。', warmingLayer: 'A', reason: '主动轻度尝试一次。' };
  const value = { ...validClassification(), fieldCoach: field };
  let calls = 0;
  const fetchImpl = async (_url, request) => {
    calls++;
    const body = JSON.parse(request.body);
    assert.equal(body.messages[1].content, knowledgeText);
    const nativeSchema = body.tools[0].function.parameters.properties.fieldCoach;
    assert.equal(nativeSchema.additionalProperties, false);
    assert.deepEqual(nativeSchema.properties.warmingLayer.enum, ['A', 'B', 'C', 'none']);
    assert.equal(nativeSchema.properties.pitfall.maxLength, 80);
    assert.equal(nativeSchema.required.includes('pitfall'), false);
    assert.equal(nativeSchema.properties.initiative.maxLength, 200);
    assert.equal(nativeSchema.properties.nextAction.maxLength, 200);
    assert.match(body.messages[2].content, /同一次提交必须提供 fieldCoach/);
    assert.match(body.messages[2].content, /currentTopic 用短话题名/);
    assert.match(body.messages[2].content, /initiative 用一句说明当前目标/);
    assert.match(body.messages[2].content, /nextAction 用一句给出具体可执行动作/);
    assert.match(body.messages[2].content, /pitfall 用一句说明当前最该避免的动作/);
    assert.match(body.messages[2].content, /这些文字字段建议各40字以内，不堆叠原理或回复示例/);
    assert.match(body.messages[2].content, /不编造对方个人雷点/);
    assert.match(body.messages[2].content, /明确拒绝时 warmingLayer 为 none，不再推进同类升级/);
    assert.match(body.messages[2].content, /模糊阻力标 ambiguous，不能当作良性阻力/);
    assert.match(body.messages[2].content, /"provenance":"inferred_from_followup"/);
    assert.match(body.messages[2].content, /"source":"user_reported"/);
    assert.match(body.messages[2].content, /"reliability":"app_interval_estimate"/);
    assert.match(body.messages[0].content, /C是明显私密或亲密暗示/);
    return mockResponse(value)();
  };
  assert.deepEqual((await classifyChat(context, { knowledgeText, env, fetchImpl })).fieldCoach, field); assert.equal(calls, 1);
  await assert.rejects(classifyChat(context, { knowledgeText, env, fetchImpl: mockResponse({ ...value, fieldCoach: { ...field, currentTopic: '声称知道话题', topicStatus: 'unknown', topicMessageIds: [] } }) }), { code: 'invalid_model_output' });
  await assert.rejects(classifyChat(context, { knowledgeText, env, fetchImpl: mockResponse({ ...value, fieldCoach: { ...field, warmingLayer: 'C' } }) }), { code: 'invalid_model_output' });
});
