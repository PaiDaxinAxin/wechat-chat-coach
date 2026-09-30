import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBetaServer } from '../src/beta-api.mjs';
import { DEFAULT_KNOWLEDGE_PATH } from '../src/knowledge.mjs';

// Deliberate opt-in verification: one provider attempt using fictional local data.
// Never part of CI; credentials are supplied privately by the calling process.
if (process.env.CHAT_COACH_STYLE_LIVE !== '1') throw new Error('LIVE_STYLE_CHECK_REQUIRES_EXPLICIT_OPT_IN');
process.umask(0o077);
const directory = await mkdtemp(join(tmpdir(), 'coach-style-live-'));
const evidenceDirectory = join(process.cwd(), 'runs/live-style');
let server;
let attemptedProviderCalls = 0;
try {
  const knowledge = await readFile(DEFAULT_KNOWLEDGE_PATH, 'utf8');
  const knowledgePath = join(directory, 'knowledge.md');
  await writeFile(knowledgePath, knowledge);
  server = await createBetaServer({ dataDir: join(directory, 'data'), knowledgePath, localDemoMode: true });
  await server.ensureDemoSeed();
  await new Promise((done, failed) => { server.once('error', failed); server.listen(0, '127.0.0.1', done); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const sessionResponse = await fetch(`${origin}/api/demo/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: '{}' });
  assert.equal(sessionResponse.status, 200);
  const { data: session } = await sessionResponse.json();
  const cookie = sessionResponse.headers.get('set-cookie').split(';')[0];
  async function call(method, path, input) {
    const response = await fetch(`${origin}${path}`, { method, headers: { cookie, origin, ...(input === undefined ? {} : { 'content-type': 'application/json', 'x-csrf-token': session.csrfToken }) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const payload = await response.json();
    if (response.status !== 200) throw Object.assign(new Error(payload.error?.code ?? 'LIVE_STYLE_REQUEST_FAILED'), { code: payload.error?.code });
    return payload.data;
  }
  const me = await call('GET', '/api/me');
  const style = await call('GET', '/api/style-learning');
  const profile = Object.fromEntries(['background', 'style', 'growthGoals', 'relationshipGoal', 'questionnaire'].map((key) => [key, me.profile[key]]));
  const rule = { target: 'current_preference', text: '用自然的中文短句回复，回答职业问题后不要连续追问，不用英文词或亲昵称呼。', conditions: '普通互相了解、刚开始聊工作时。', limits: '保留真实职业信息；这条只表示虚构使用者的表达偏好，不是效果证明。' };
  await call('PUT', '/api/profile', { ...profile, styleLearning: { requestId: 'live_style_adopt_once', expectedRevision: style.revision, ruleChange: { type: 'adopt_new', rule } } });
  const before = server.betaStore.listJobs(session.user.id, session.counterpartId).length;
  const input = { requestId: 'live_style_reply_once', direction: 'down' };
  attemptedProviderCalls = 1;
  const reply = await call('POST', `/api/counterparts/${session.counterpartId}/reply`, input);
  assert.equal(reply.cached, false);
  assert.ok(reply.suggestion);
  const replay = await call('POST', `/api/counterparts/${session.counterpartId}/reply`, input);
  assert.equal(replay.cached, true);
  const after = server.betaStore.listJobs(session.user.id, session.counterpartId);
  assert.equal(after.length, before + 1);
  const source = server.betaStore.getSuggestionCase(session.user.id, session.counterpartId, reply.suggestion.id);
  assert.equal(source.status, 'complete');
  const personalContext = JSON.parse(source.snapshot.modelInput.userProfile);
  assert.ok(JSON.stringify(personalContext).includes(rule.text));
  assert.equal(personalContext.currentStyle, profile.style);
  assert.equal(personalContext.growthGoals, profile.growthGoals);
  // Archive equality is verified without displaying private knowledge or paths.
  const archive = await readFile(join(directory, 'data', 'knowledge-versions', `${source.snapshot.knowledge.hash}.md`), 'utf8');
  assert.equal(archive, knowledge);
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(join(evidenceDirectory, 'result.json'), JSON.stringify({ passed: true, synthetic: true, attemptedProviderCalls, operation: 'reply', cachedReplay: true, fullKnowledgeBytes: Buffer.byteLength(knowledge), activeRuleInImmutableInput: true, realStyleEffectivenessEstablished: false, replyCharacters: reply.suggestion.reply.length }, null, 2) + '\n');
  console.log('Live personal-style integration passed: one deliberate provider attempt, stored active preference, full knowledge archive and cached replay.');
} catch (error) {
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(join(evidenceDirectory, 'result.json'), JSON.stringify({ passed: false, synthetic: true, attemptedProviderCalls, operation: 'reply', errorCode: /^[A-Z_0-9]+$/.test(error.code ?? '') ? error.code : 'LIVE_STYLE_CHECK_FAILED', automaticRetry: false }, null, 2) + '\n');
  console.error('Live personal-style verification failed; sanitized evidence recorded. No automatic retry.');
  process.exitCode = 1;
} finally {
  if (server?.listening) await new Promise((done) => server.close(done));
  else server?.betaStore.close();
  await rm(directory, { recursive: true, force: true });
}
