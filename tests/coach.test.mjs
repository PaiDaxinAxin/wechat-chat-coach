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
    json: async () => ({ choices: [{ finish_reason: options.finishReason ?? 'stop', message: { content: options.raw ?? JSON.stringify(value) } }] }),
  });
}

test('classification sends the complete knowledge and known Agnes request shape', async () => {
  let calls = 0;
  const fetchImpl = async (url, request) => {
    calls += 1;
    assert.equal(url, 'https://api.agnes-ai.cn/v1/chat/completions');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.Authorization, 'Bearer mock-key');
    const body = JSON.parse(request.body);
    assert.equal(body.messages[1].content, knowledgeText);
    assert.equal(body.model, 'agnes-3.0-flash');
    assert.equal(body.chat_template_kwargs.enable_thinking, false);
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
