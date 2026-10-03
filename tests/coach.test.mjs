import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatInputSchema, ReplyInputSchema, classifyChat, generateReply, CoachError } from '../src/coach.mjs';
import { computeHeat } from '../src/domain.mjs';

const env = { AGNES_API_KEY: 'mock-key' };
const workingFocus = { stage: 'unknown', reason: '背景有限，主要着力点仍需观察。', evidenceIds: [] };
const knowledgeText = '原始知识第一行。\n第二行完整保留。\n'.repeat(1000);
const input = {
  userProfile: '虚构用户，喜欢简洁直接。',
  counterpartProfile: '虚构对象，背景暂时有限。',
  messages: [{ id: 'm1', speaker: 'other', text: '最近忙工作，你呢？' }],
};

function validClassification() {
  const unknown = () => ({ level: 'unknown', evidenceIds: [] });
  return {
    status: 'ready', confidence: 'limited', phase: 'ordinary', contextUpdates: { facts: [], meeting: null },
    workingFocus: structuredClone(workingFocus), topicDecision: { mode: 'change', reason: '当前适合调整话题方向。' },
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
    assert.match(body.messages[0].content, /只有首句也可以记录有限的积极信号/);
    assert.match(body.messages[0].content, /主动提问、具体展开或自发联系可能支持当轮观察/);
    assert.match(body.messages[0].content, /字数多不等于高热度，长篇拒绝仍是拒绝/);
    assert.match(body.messages[0].content, /敷衍问好、礼貌回应或单独问句也不自动判高或低/);
    assert.match(body.messages[0].content, /热度初判与范围只是未经校准的参考，不是科学概率/);
    assert.match(body.messages[0].content, /新增消息、批注或背景后重新综合，允许初判随新证据更新/);
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
    assert.equal(parameters.properties.options.minItems, undefined);
    assert.ok(parameters.required.includes('topicDecision'));
    assert.ok(parameters.required.includes('workingFocus'));
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

test('one sparse message yields a provisional judgment and a concrete information-gathering action', async () => {
  const value = validClassification();
  value.topicDecision = { mode: 'stay', reason: '先接住唯一的一句，不强行换题。' };
  value.options = [];
  value.workingFocus = { stage: 'value_display', reason: '先让对方了解真实的日常。', evidenceIds: ['m1'] };
  value.heat.personalInterest = { level: 'unknown', evidenceIds: [] };
  value.fieldCoach = { currentTopic: '工作日常', topicStatus: 'developing', topicMessageIds: ['m1'], warmingLayer: 'none',
    initiative: '先回应工作近况，获得一个具体话题。', nextAction: '简短说自己的近况，问她主要忙哪部分。',
    pitfall: '通用提醒：不要连续盘问。', reason: '她提了工作并问你，可先自然接话。' };
  let calls = 0;
  const result = await classifyChat(input, { knowledgeText, env, fetchImpl: async (...args) => {
    calls++;
    const task = JSON.parse(args[1].body).messages[2].content;
    assert.match(task, /不等消息条数、轮数或热度评分达到阈值/);
    assert.doesNotMatch(task, /输入为空或不足时标 needs_context/);
    return mockResponse(value)(...args);
  } });
  assert.equal(result.status, 'ready');
  assert.equal(result.confidence, 'limited');
  assert.equal(result.workingFocus.stage, 'value_display');
  assert.equal(result.fieldCoach.nextAction, value.fieldCoach.nextAction);
  const heat = computeHeat(result, { context: input });
  assert.equal(heat.score, null, 'A useful first-step judgment does not invent a precise score');
  assert.deepEqual([heat.preliminaryRange.lower, heat.preliminaryRange.upper], [35, 75]);
  assert.equal(calls, 1);
});

test('extra heat-dimension commentary is discarded without weakening the evidence contract or retrying', async () => {
  const value = validClassification();
  for (const dimension of Object.values(value.heat)) dimension.explanation = 'Unused provider commentary';
  let calls = 0;
  const result = await classifyChat(input, { knowledgeText, env, fetchImpl: async (...args) => { calls++; return mockResponse(value)(...args); } });
  for (const dimension of Object.values(result.heat)) assert.deepEqual(Object.keys(dimension), ['level', 'evidenceIds']);
  assert.equal(value.heat.activeInteraction.explanation, 'Unused provider commentary', 'Do not mutate the input');
  assert.equal(calls, 1);
  for (const [mutate, code] of [
    [(v) => { v.heat.responseEngagement.evidenceIds = ['invented-id']; }, 'invalid_evidence_reference'],
    [(v) => { v.heat.responseEngagement.level = 'unbounded'; }, 'invalid_value'],
    [(v) => { v.heat.responseEngagement.level = 'unknown'; }, 'unknown_heat_with_evidence'],
    [(v) => { v.heat.responseEngagement.evidenceIds = ['m1', 'm1']; }, 'duplicate_evidence'],
    [(v) => { v.heat.extraDimension = { level: 'positive', evidenceIds: ['m1'] }; }, 'unrecognized_keys'],
    [(v) => { v.extraSummary = 'outside the allowed compatibility scope'; }, 'unrecognized_keys'],
  ]) {
    const invalid = structuredClone(value); mutate(invalid); let attempts = 0;
    await assert.rejects(classifyChat(input, { knowledgeText, env, fetchImpl: async (...args) => { attempts++; return mockResponse(invalid)(...args); } }),
      (error) => error.code === 'invalid_model_output' && error.diagnostics.some((item) => item.code === code));
    assert.equal(attempts, 1);
  }
});

test('a developing conversation can keep its topic without invented direction choices or weights', async () => {
  const value = validClassification();
  value.topicDecision = { mode: 'stay', reason: '对方正在展开经历，先接住内容。' };
  value.options = [];
  value.workingFocus = { stage: 'emotion', reason: '她正在分享有意思的经历。', evidenceIds: ['m1'] };
  const result = await classifyChat(input, { knowledgeText, env, fetchImpl: mockResponse(value) });
  assert.deepEqual(result.options, []);
  assert.equal(result.workingFocus.stage, 'emotion');
  const withOptions = { ...value, options: validClassification().options };
  await assert.rejects(classifyChat(input, { knowledgeText, env, fetchImpl: mockResponse(withOptions) }),
    (error) => error.code === 'invalid_model_output' && error.diagnostics[0].code === 'stay_with_topic_options');
  await assert.rejects(classifyChat(input, { knowledgeText, env, fetchImpl: mockResponse({ ...value, topicDecision: { ...value.topicDecision, mode: 'change' } }) }),
    (error) => error.code === 'invalid_model_output' && error.diagnostics[0].code === 'invalid_direction_set');
});

test('explicit topic request reaches the classifier while the action remains independently assessed', async () => {
  const requested = { ...input, topicChangeRequested: true };
  let calls = 0;
  const result = await classifyChat(requested, { knowledgeText, env, fetchImpl: async (_url, request) => {
    calls++;
    const body = JSON.parse(request.body);
    const sent = JSON.parse(body.messages[2].content.split('本轮输入数据：\n')[1]);
    assert.equal(sent.topicChangeRequested, true);
    assert.match(body.messages[0].content, /正常深入当前话题不必贴“下切”标签/);
    assert.match(body.messages[2].content, /用户请求换题但当前应停止推进或先处理顾虑/);
    return mockResponse(validClassification())();
  } });
  assert.equal(result.topicDecision.mode, 'change');
  assert.equal(result.options.length, 3);
  assert.equal(calls, 1);
});

test('working focus needs actual evidence and missing new policy fields are not accepted as fresh output', async () => {
  const mutations = [
    (value) => { delete value.workingFocus; },
    (value) => { delete value.topicDecision; },
    (value) => { value.workingFocus.evidenceIds = ['m1']; },
    (value) => { value.workingFocus.stage = 'security'; },
    (value) => { value.workingFocus = { stage: 'value_display', reason: '了解真实特点。', evidenceIds: ['invented-offline-event'] }; },
  ];
  for (const mutate of mutations) {
    const value = validClassification(); mutate(value);
    await assert.rejects(classifyChat(input, { knowledgeText, env, fetchImpl: mockResponse(value) }), { code: 'invalid_model_output' });
  }
});

test('deepening or playful exchange does not require a topic direction; a selected direction must be honored', async () => {
  for (const relationMove of ['deepen', 'push_pull']) {
    const value = { contextUpdates: { facts: [], meeting: null }, workingFocus: { stage: 'emotion', reason: '顺着实际表达继续交流。', evidenceIds: ['m1'] }, reply: '这个项目哪里最有意思？', reason: '继续聊她正在分享的内容。', action: 'reply', styleNote: '简短自然。',
      guidance: { topicMove: null, relationMove, ownWordsGuide: '接住她正在分享的一点。', reentryWhen: '她继续展开时自然接话。' } };
    assert.deepEqual(await generateReply({ context: input }, { knowledgeText, env, fetchImpl: mockResponse(value) }), value);
    await assert.rejects(generateReply({ context: input, direction: 'down' }, { knowledgeText, env, fetchImpl: mockResponse(value) }), { code: 'invalid_model_output' });
    const noEvidence = { ...value, workingFocus: { ...value.workingFocus, evidenceIds: [] } };
    await assert.rejects(generateReply({ context: input }, { knowledgeText, env, fetchImpl: mockResponse(noEvidence) }), { code: 'invalid_model_output' });
  }
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
  const value = { contextUpdates: { facts: [], meeting: null }, workingFocus, reply: '', reason: '对方已经明确表示不想继续。', action: 'pause', styleNote: '暂时停止追问。', guidance: { topicMove: null, relationMove: 'pause', ownWordsGuide: '本轮先停止推进。', reentryWhen: '对方明确愿意恢复交流时再判断。' } };
  const fetchImpl = async (_url, request) => {
    const body = JSON.parse(request.body);
    assert.equal(body.messages[1].content, knowledgeText);
    assert.match(body.messages[2].content, /"direction":"down"/);
    const parameters = body.tools[0].function.parameters;
    assert.equal(body.tools.length, 1);
    assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'submit_coaching_result' } });
    assert.equal(parameters.additionalProperties, false);
    assert.deepEqual(Object.keys(parameters.properties).sort(), ['action', 'contextUpdates', 'guidance', 'reason', 'reply', 'styleNote', 'workingFocus']);
    assert.equal(parameters.required.includes('contextUpdates'), true, 'Fresh native output requires the complete projection');
    assert.equal(parameters.required.includes('guidance'), true, 'Every fresh native reply must include direction guidance');
    assert.equal(parameters.properties.reply.maxLength, 350);
    assert.deepEqual(parameters.properties.action.enum, ['reply', 'wait', 'clarify', 'invite', 'pause']);
    return mockResponse(value)();
  };
  assert.deepEqual(await generateReply({ context: input, direction: 'down' }, { knowledgeText, env, fetchImpl }), value);
});

test('reply length limits and required reply text are validated', async () => {
  const base = { contextUpdates: { facts: [], meeting: null }, workingFocus, reply: '你主要忙哪一类工作？', reason: '了解工作的大类。', action: 'reply', styleNote: '保持简短自然。', guidance: { topicMove: 'up', relationMove: 'continue', ownWordsGuide: '先了解她的大致工作方向。', reentryWhen: '她继续展开时接话。' } };
  const cases = [{ ...base, reply: '长'.repeat(351) }, { ...base, reason: '长'.repeat(201) }, { ...base, styleNote: '长'.repeat(201) }, { ...base, reply: '' }, { ...base, raw: knowledgeText }];
  for (const value of cases) {
    await assert.rejects(generateReply({ context: input }, { knowledgeText, env, fetchImpl: mockResponse(value) }), { code: 'invalid_model_output' });
  }
  assert.deepEqual(await generateReply({ context: input }, { knowledgeText, env, fetchImpl: mockResponse(base) }), base);
});

test('fresh native replies without guidance fail closed instead of being labeled as legacy records', async () => {
  const legacy = { contextUpdates: { facts: [], meeting: null }, workingFocus, reply: '你主要忙哪一类工作？', reason: '了解工作的大类。', action: 'reply', styleNote: '保持简短自然。' };
  let calls = 0;
  await assert.rejects(generateReply({ context: input }, { knowledgeText, env, fetchImpl: async () => { calls++; return mockResponse(legacy)(); } }),
    (error) => error.code === 'invalid_model_output' && JSON.stringify(error.diagnostics) === JSON.stringify([{ code: 'invalid_type', path: ['guidance'] }]));
  assert.equal(calls, 1, 'Malformed output does not trigger another model call');
});

test('a single native reply call provides independent topic and relationship guidance for users to use their own words', async () => {
  const value = { contextUpdates: { facts: [], meeting: null }, workingFocus, reply: '感觉你挺认真。最近哪个部分最有意思？', reason: '承接她的投入，再轻度表达欣赏。', action: 'reply', styleNote: '用自己的说法表达真实感受。',
    guidance: { topicMove: 'down', relationMove: 'light_approach', ownWordsGuide: '先说出你真实欣赏的一点，再问一个细节。', reentryWhen: '她继续展开时顺着新内容接话。' } };
  let calls = 0;
  const fetchImpl = async (_url, request) => {
    calls++;
    const body = JSON.parse(request.body);
    assert.equal(body.messages[1].content, knowledgeText);
    assert.equal(body.tools.length, 1); assert.equal(body.parallel_tool_calls, false);
    const guidance = body.tools[0].function.parameters.properties.guidance;
    assert.equal(guidance.additionalProperties, false);
    assert.deepEqual(guidance.required.sort(), ['ownWordsGuide', 'reentryWhen', 'relationMove', 'topicMove']);
    assert.equal(guidance.properties.ownWordsGuide.maxLength, 200);
    assert.match(body.messages[2].content, /本次提交同时提供 guidance/);
    assert.match(body.messages[2].content, /relationMove 单独判断/);
    assert.match(body.messages[2].content, /不要求用户照抄/);
    assert.match(body.messages[0].content, /单独一句“哈哈”或表情不能直接判低热度/);
    assert.match(body.messages[0].content, /当前话题是否自然结束/);
    assert.match(body.messages[0].content, /完整双方画像、认识背景、全部已保存聊天与当前见面状态/);
    assert.match(body.messages[0].content, /性吸引、信任、恋爱意愿分别看待/);
    assert.match(body.messages[0].content, /待验证观点，不是已验证事实或承诺/);
    assert.match(body.messages[0].content, /不凭线上热度推定线下亲密行为已获同意/);
    return mockResponse(value)();
  };
  assert.deepEqual(await generateReply({ context: input, direction: 'down' }, { knowledgeText, env, fetchImpl }), value);
  assert.equal(calls, 1);
});

test('waiting guidance can be visible without a sendable reply and names conditions rather than a fixed delay', async () => {
  const context = { ...input, messages: [{ id: 'm1', speaker: 'other', text: '哈哈🙂' }] };
  for (const action of ['wait', 'pause']) {
    const value = { contextUpdates: { facts: [], meeting: null }, workingFocus, reply: '', reason: action === 'wait' ? '本话题已自然收住；单句表情不足以判低兴趣。' : '对方明确不愿继续这类推进，应尊重边界。', action, styleNote: '不需要为了保持聊天而硬续一句。',
      guidance: { topicMove: null, relationMove: action, ownWordsGuide: '本轮先不发送，保留自然留白。', reentryWhen: action === 'wait' ? '她有新的内容，或你有真实新话题时再判断。' : '对方明确愿意恢复这类交流时再判断。' } };
    const fetchImpl = async (_url, request) => {
      const body = JSON.parse(request.body);
      assert.match(body.messages[2].content, /不要硬定等几小时、几天/);
      assert.match(body.messages[2].content, /不把拒绝当成需要突破的测试/);
      assert.match(body.messages[2].content, /单一哈哈或emoji不等于低热度/);
      return mockResponse(value)();
    };
    assert.deepEqual(await generateReply({ context }, { knowledgeText, env, fetchImpl }), value);
  }
});

test('delayed laughter case keeps three conditional branches, alternative explanations and evidence boundaries in native prompts', async () => {
  const context = { ...input, messages: [
    { id: 'm1', speaker: 'other', text: '之前和你聊天挺开心的。' },
    { id: 'm2', speaker: 'other', text: '哈哈', recordedAt: '2026-10-01T04:00:00.000Z' },
    { id: 'm3', speaker: 'other', text: '🙂', recordedAt: '2026-10-01T07:00:00.000Z' },
    { id: 'm4', speaker: 'other', text: '哈哈', recordedAt: '2026-10-01T10:00:00.000Z' },
  ] };
  const waiting = { contextUpdates: { facts: [], meeting: null }, workingFocus, reply: '', reason: '当前原因仍不确定，可先自然收尾。', action: 'wait', styleNote: '保持轻松，不逐字纠结。', guidance: { topicMove: null, relationMove: 'wait', ownWordsGuide: '先留一点空间。', reentryWhen: '有真实新话题或对方主动展开时再判断。' } };
  let calls = 0;
  const fetchImpl = async (_url, request) => {
    const body = JSON.parse(request.body), system = body.messages[0].content, task = body.messages[2].content;
    assert.match(system, /连续3次隔几小时只回哈哈或emoji/);
    for (const alternative of ['对本人兴趣有限', '对当前话题没兴趣', '不知道怎么接']) assert.ok(system.includes(alternative));
    assert.match(system, /此前热度>65.*资料或此前原话中真实提过的话题/);
    assert.match(system, /原本投入不高.*先不回.*用户提供具体朋友圈动态/);
    assert.match(system, /过去有双向暧昧.*可能在忙.*晚些或晚上聊别的/);
    for (const bound of ['不是成功概率或机械阈值', '未提供旧分数不补造分数', '不能写成事实', '不编造她的兴趣或经历', '朋友圈仅用用户提供的内容，不访问或抓取', '不是固定等待小时数', '历史暧昧不覆盖明确拒绝', '保持轻松玩乐，不逐字逐句计较']) assert.ok(system.includes(bound), bound);
    assert.ok(body.messages[1].content === knowledgeText);
    const sent = JSON.parse(task.split('本轮输入数据：\n')[1]);
    assert.deepEqual(sent.context ?? sent, context);
    if (calls++ === 0) return mockResponse(validClassification())();
    assert.match(task, /“换已知话题”“先留白等具体契机”“晚些再聊别的”/);
    assert.match(task, /不机械叠加三步/);
    assert.match(task, /不把历史暧昧当成突破拒绝的理由/);
    return mockResponse(waiting)();
  };
  await classifyChat(context, { knowledgeText, env, fetchImpl });
  assert.deepEqual(await generateReply({ context }, { knowledgeText, env, fetchImpl }), waiting);
  assert.equal(calls, 2, 'Only the two requested operations run; this verifies prompts, not model interpretation');
});

test('guidance bounds, closed fields and selected direction are validated without raw output diagnostics', async () => {
  const base = { contextUpdates: { facts: [], meeting: null }, workingFocus, reply: '再了解一个细节。', reason: '依据当前话题。', action: 'reply', styleNote: '保留真实表达。', guidance: { topicMove: 'down', relationMove: 'receive', ownWordsGuide: '先回应，再问一个细节。', reentryWhen: '有新的内容时继续。' } };
  for (const value of [
    { ...base, guidance: { ...base.guidance, ownWordsGuide: '长'.repeat(201) } },
    { ...base, guidance: { ...base.guidance, reentryWhen: '' } },
    { ...base, guidance: { ...base.guidance, relationMove: 'private-raw-untrusted-marker' } },
    { ...base, guidance: { ...base.guidance, rawKnowledge: knowledgeText } },
    { ...base, guidance: { ...base.guidance, topicMove: 'up' } },
    { ...base, action: 'wait', guidance: { ...base.guidance, topicMove: null, relationMove: 'wait' } },
    { ...base, reply: '', action: 'pause', guidance: { ...base.guidance, topicMove: null, relationMove: 'invite' } },
    { ...base, reply: '', action: 'wait', guidance: { ...base.guidance, topicMove: null, relationMove: 'light_approach' } },
  ]) {
    await assert.rejects(generateReply({ context: input, direction: 'down' }, { knowledgeText, env, fetchImpl: mockResponse(value) }), (error) => {
      assert.equal(error.code, 'invalid_model_output');
      assert.doesNotMatch(JSON.stringify(error), /private-raw-untrusted-marker|原始知识第一行/);
      return true;
    });
  }
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
    assert.match(body.messages[2].content, /initiative 用一句说明后续对话方向，点明接下来聊什么、如何发展/);
    assert.match(body.messages[2].content, /nextAction 用一句给出紧邻的具体可执行动作/);
    assert.match(body.messages[2].content, /pitfall 用一句说明当前最该避免的动作/);
    assert.match(body.messages[2].content, /这些文字字段建议各40字以内，不堆叠原理或回复示例/);
    assert.match(body.messages[2].content, /不编造对方个人雷点/);
    for (const rule of ['本轮给出 pitfall', '没有个性依据时明确标“通用提醒”', '低热度默认避免连问催回、长篇证明或强行升温', '中热度默认先承接当前内容', '高热度默认避免过度升温、用试探拉扯破坏回应或忽视边界', '不把未知当低热度', '不泛写“继续聊”“提升热度”“输出价值”等含糊作业', '需要留白或停止时说明再接的真实条件']) {
      assert.ok(body.messages[2].content.includes(rule), rule);
    }
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

test('each native coaching call requires a complete evidence-backed context projection without another request', async () => {
  const context = { ...input, messages: [
    { id: 'self', speaker: 'self', text: '周六 19:00 一起去湖畔咖啡见面？' },
    { id: 'm1', speaker: 'other', text: '我是品牌策划。好，周六 19:00 湖畔咖啡见。' },
  ] };
  const updates = { facts: [{ subject: 'other', field: 'work', value: '品牌策划', evidence: [{ messageId: 'm1', quote: '我是品牌策划', source: 'text' }] }], meeting: { status: 'confirmed', time: '周六 19:00', place: '湖畔咖啡', note: '双方记录了具体安排。', evidence: [{ messageId: 'self', quote: '周六 19:00 一起去湖畔咖啡见面？', source: 'text' }, { messageId: 'm1', quote: '好，周六 19:00 湖畔咖啡见。', source: 'text' }] } };
  const reply = { contextUpdates: updates, workingFocus, reply: '到时见。', reason: '承接已明确约定。', action: 'reply', styleNote: '简短确认真实安排。', guidance: { topicMove: null, relationMove: 'receive', ownWordsGuide: '用自己的话承接安排。', reentryWhen: '安排有变化时再确认。' } };
  let calls = 0;
  const fetchImpl = async (_url, request) => {
    const body = JSON.parse(request.body); assert.equal(body.messages[1].content, knowledgeText);
    assert.equal(body.tools.length, 1); const schema = body.tools[0].function.parameters;
    assert.equal(schema.required.includes('contextUpdates'), true); assert.equal(schema.properties.contextUpdates.additionalProperties, false);
    assert.equal(schema.properties.contextUpdates.properties.facts.items.properties.evidence.items.properties.quote.maxLength, 300);
    for (const rule of ['完整原始聊天重新建立', '新证据纠正旧信息', '旧证据不能改写该安排', '图片记录', '不能从本轮 AI 建议', '不把自我事实跨对象传播']) assert.ok(body.messages[0].content.includes(rule), rule);
    assert.deepEqual(JSON.parse(body.messages[2].content.split('本轮输入数据：\n')[1]).context ?? JSON.parse(body.messages[2].content.split('本轮输入数据：\n')[1]), context);
    assert.equal(body.max_tokens, calls === 0 ? 4500 : 3500);
    return mockResponse(calls++ === 0 ? { ...validClassification(), contextUpdates: updates } : reply)();
  };
  assert.deepEqual((await classifyChat(context, { knowledgeText, env, fetchImpl })).contextUpdates, updates);
  assert.deepEqual((await generateReply({ context }, { knowledgeText, env, fetchImpl })).contextUpdates, updates);
  assert.equal(calls, 2, 'One requested classify and one requested reply, with no extraction-only model call');
});

test('missing native projection remains required without an automatic retry', async () => {
  const reply = { workingFocus, reply: '自然接话。', reason: '结合当前内容。', action: 'reply', styleNote: '保留真实表达。', guidance: { topicMove: null, relationMove: 'continue', ownWordsGuide: '接住当前内容。', reentryWhen: '对方展开后再继续。' } };
  const classification = validClassification(); delete classification.contextUpdates;
  for (const [operation, value] of [['classify', classification], ['reply', reply]]) {
    let calls = 0;
    const fetchImpl = async () => { calls++; return mockResponse(value)(); };
    await assert.rejects(operation === 'classify' ? classifyChat(input, { knowledgeText, env, fetchImpl }) : generateReply({ context: input }, { knowledgeText, env, fetchImpl }), (error) => error.code === 'invalid_model_output' && error.diagnostics.some(({ path }) => path[0] === 'contextUpdates'));
    assert.equal(calls, 1);
  }
});

test('invalid auxiliary extraction cannot discard valid native coaching or create a second request', async () => {
  const good = { subject: 'other', field: 'availability', value: '近期工作忙', evidence: [{ messageId: 'm1', quote: '最近忙工作', source: 'text' }] };
  const bad = { subject: 'other', field: 'work', value: 'private-value-never-return', evidence: [{ messageId: 'm1', quote: 'private-evidence-never-return', source: 'text' }] };
  const reply = { workingFocus, reply: '自然接话。', reason: '结合当前内容。', action: 'reply', styleNote: '保留真实表达。', guidance: { topicMove: null, relationMove: 'continue', ownWordsGuide: '接住当前内容。', reentryWhen: '对方展开后再继续。' } };
  for (const updates of [
    { facts: [bad, good], meeting: { status: 'confirmed', time: '周六', place: '咖啡店', note: '', evidence: good.evidence } },
    { facts: [{ ...bad, evidence: [] }, good], meeting: null },
    null,
  ]) {
    for (const [operation, value] of [['classify', validClassification()], ['reply', reply]]) {
      let calls = 0;
      const fetchImpl = async () => { calls++; return mockResponse({ ...value, contextUpdates: updates })(); };
      const result = await (operation === 'classify' ? classifyChat(input, { knowledgeText, env, fetchImpl }) : generateReply({ context: input }, { knowledgeText, env, fetchImpl }));
      assert.deepEqual(result.contextUpdates, { facts: updates === null ? [] : [good], meeting: null });
      assert.deepEqual({ ...result, contextUpdates: undefined }, { ...value, contextUpdates: undefined });
      assert.ok(!JSON.stringify(result).includes('private-'));
      assert.equal(calls, 1, 'Sanitization does not retry or perform a separate extraction call');
    }
  }
});

test('sanitizing auxiliary extraction never weakens core evidence validation', async () => {
  const updates = { facts: [{ subject: 'other', field: 'work', value: 'private-value', evidence: [] }], meeting: null };
  const classification = { ...validClassification(), contextUpdates: updates };
  classification.heat.responseEngagement.evidenceIds = ['missing-core-id'];
  const reply = { contextUpdates: updates, workingFocus: { stage: 'emotion', reason: '当前内容。', evidenceIds: ['missing-core-id'] }, reply: '自然接话。', reason: '结合当前内容。', action: 'reply', styleNote: '保留真实表达。', guidance: { topicMove: null, relationMove: 'continue', ownWordsGuide: '接住当前内容。', reentryWhen: '对方展开后再继续。' } };
  for (const [operation, value] of [['classify', classification], ['reply', reply]]) {
    let calls = 0;
    const fetchImpl = async () => { calls++; return mockResponse(value)(); };
    await assert.rejects(operation === 'classify' ? classifyChat(input, { knowledgeText, env, fetchImpl }) : generateReply({ context: input }, { knowledgeText, env, fetchImpl }), (error) => error.code === 'invalid_model_output' && error.diagnostics.some(({ code }) => code === 'invalid_evidence_reference') && !JSON.stringify(error).includes('private-value'));
    assert.equal(calls, 1);
  }
});
