import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createBetaServer } from '../src/beta-api.mjs';
import { seedOwner } from '../src/beta-store.mjs';
import { QUESTIONNAIRES } from '../src/domain.mjs';
import { classifyChat, generateReply } from '../src/coach.mjs';
import { DEFAULT_KNOWLEDGE_PATH } from '../src/knowledge.mjs';

// Explicit bounded live probe: one classify and one reply; no automatic retries.
const directory = await mkdtemp(join(tmpdir(), 'coach-live-'));
const knowledgePath = join(directory, 'knowledge.md');
const knowledgeText = await readFile(DEFAULT_KNOWLEDGE_PATH, 'utf8');
await writeFile(knowledgePath, knowledgeText);
let providerCalls = 0, fullKnowledgeVerified = 0;
const metrics = [];
const observedFetch = async (url, options) => {
  if (++providerCalls > 2) throw new Error('LIVE_PROBE_BUDGET_EXCEEDED');
  const request = JSON.parse(options.body);
  if (request.messages?.[1]?.content !== knowledgeText) throw new Error('FULL_KNOWLEDGE_NOT_PRESENT');
  fullKnowledgeVerified++;
  return globalThis.fetch(url, options);
};
const server = await createBetaServer({
  dataDir: join(directory, 'data'), knowledgePath,
  classifyFn: (input, options) => classifyChat(input, { ...options, fetchImpl: observedFetch }),
  replyFn: (input, options) => generateReply(input, { ...options, fetchImpl: observedFetch }),
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
let cookie, csrf;
async function request(path, method, input) {
  const response = await fetch(`${origin}${path}`, {
    method, headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  const output = await response.json();
  if (!response.ok) { const error = new Error(); error.code = output.error?.code; throw error; }
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  if (output.data.csrfToken) csrf = output.data.csrfToken;
  return output.data;
}
const record = {
  observedAt: new Date().toISOString(), synthetic: true,
  providerModel: process.env.AGNES_MODEL ?? 'agnes-3.0-flash',
  knowledgeHash: createHash('sha256').update(knowledgeText).digest('hex'), knowledgeBytes: Buffer.byteLength(knowledgeText),
};
try {
  const owner = await seedOwner(server.betaStore, { username: 'smoke-owner', password: 'SyntheticPassword2026' });
  const invite = server.betaStore.createInvite({ ownerId: owner.id, plan: 'free' }).invite;
  await request('/api/register', 'POST', { invite, username: 'smoke-free', password: 'SyntheticPassword2026' });
  await request('/api/profile', 'PUT', {
    background: '匿名内测场景：男生，从事设计工作，周末喜欢散步。',
    style: '说话简短、平实，不习惯夸张的调侃。', growthGoals: '练习回应兴趣，并自然了解对方。', relationshipGoal: '先了解彼此，再协商是否见面。',
    questionnaire: { kind: 'short', answers: Object.fromEntries(QUESTIONNAIRES.short.map(({ id }) => [id, 4])) },
  });
  const { counterpart } = await request('/api/counterparts', 'POST', { alias: '匿名对象', channel: 'app', appProfile: '资料提到设计、咖啡和城市散步。', offlineScene: '', background: '交友软件认识，聊过两轮，无线下安排。', rounds: 2 });
  for (const [speaker, text] of [['other', '最近一直在忙工作。'], ['self', '你是做设计方面的吗？'], ['other', '是啊，最近一个项目很赶。你平时下班喜欢做什么？']]) await request(`/api/counterparts/${counterpart.id}/messages`, 'POST', { speaker, text });
  let started = Date.now();
  const classified = await request(`/api/counterparts/${counterpart.id}/classify`, 'POST', { requestId: 'live-classify-001' });
  metrics.push({ operation: 'classify', elapsedMs: Date.now() - started, cached: classified.cached, options: classified.classification.options.map(({ topicMove }) => topicMove), quotaRemaining: classified.quota.classificationRemaining });
  started = Date.now();
  const reply = await request(`/api/counterparts/${counterpart.id}/reply`, 'POST', { requestId: 'live-reply-001', direction: 'down' });
  metrics.push({ operation: 'reply', elapsedMs: Date.now() - started, cached: reply.cached, action: reply.suggestion.action });
  const replay = await request(`/api/counterparts/${counterpart.id}/classify`, 'POST', { requestId: 'live-classify-001' });
  if (!replay.cached || providerCalls !== 2 || fullKnowledgeVerified !== 2) throw new Error('LIVE_PROBE_INVARIANT_FAILED');
  record.passed = true;
} catch (error) {
  record.passed = false;
  record.error = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'LIVE_PROBE_FAILED';
  process.exitCode = 1;
} finally {
  Object.assign(record, { providerCalls, fullKnowledgeVerified, metrics });
  await mkdir('runs', { recursive: true });
  await writeFile('runs/beta-live.json', JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify(record));
  await new Promise((done) => server.close(done));
  await rm(directory, { recursive: true, force: true });
}
