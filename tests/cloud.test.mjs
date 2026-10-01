import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cloudSettings, acceptsDeploymentRequest, normalizeDeploymentUrl } from '../src/cloud.mjs';

const env = { VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_URL: 'wechat-chat-coach-synthetic.vercel.app',
  CHAT_COACH_PREVIEW_OWNER_ID: 'fixture-owner-id-12345',
  CHAT_COACH_DATABASE_URL: 'postgresql://chat_coach_app.eucsgmsalvgqjfeazcyp:synthetic@aws-1-ap-northeast-1.pooler.supabase.com:6543/postgres' };

test('owner preview startup rejects production, alternate database and incomplete configuration', () => {
  assert.equal(cloudSettings(env).origin, 'https://' + env.VERCEL_URL);
  for (const changed of [{ VERCEL_ENV: 'production' }, { VERCEL_ENV: 'development' }, { VERCEL: '0' }, { VERCEL_URL: 'example.com' }, { VERCEL_URL: 'abc.vercel.app/path' }, { CHAT_COACH_PREVIEW_OWNER_ID: '' }, { CHAT_COACH_DATABASE_URL: env.CHAT_COACH_DATABASE_URL.replace('chat_coach_app.eucsgmsalvgqjfeazcyp', 'postgres.other') }, { CHAT_COACH_DATABASE_URL: env.CHAT_COACH_DATABASE_URL + '?sslmode=disable' }, { CHAT_COACH_GLOBAL_PROVIDER_DAILY_LIMIT: '0' }]) assert.throws(() => cloudSettings({ ...env, ...changed }));
});

test('only the deployment Host is accepted; forwarded hosts never authorize an alias', () => {
  assert.equal(acceptsDeploymentRequest({ headers: { host: env.VERCEL_URL } }, env.VERCEL_URL), true);
  for (const host of ['wechat-chat-coach.vercel.app', 'branch-preview.vercel.app', 'localhost', undefined, env.VERCEL_URL + ':443', env.VERCEL_URL + ',evil.test']) {
    assert.equal(acceptsDeploymentRequest({ headers: { host, 'x-forwarded-host': env.VERCEL_URL, forwarded: 'host=' + env.VERCEL_URL } }, env.VERCEL_URL), false);
  }
});

test('deployment serves explicit public output and preserves all protected API paths', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.equal(config.outputDirectory, 'dist/public');
  assert.deepEqual(config.rewrites.map(x => x.source), ['/api/:path*', '/mcp', '/health']);
  assert.ok(config.functions['api/index.mjs'].maxDuration <= 120);
});

test('hosted owner entry is explicitly injected and keeps origin, cookie and account checks', async (t) => {
  const { createBetaServer } = await import('../src/beta-api.mjs');
  const { request } = await import('node:http');
  let sessions = 0;
  const store = {
    getUser: async (id) => ({ id, role: id === env.CHAT_COACH_PREVIEW_OWNER_ID ? 'owner' : 'user' }),
    createSession: async () => { sessions++; return { token: 'synthetic-session', csrfToken: 'synthetic-csrf' }; },
  };
  const options = { store, webDir: null, publicOrigin: 'https://' + env.VERCEL_URL, storeKnowledge: { read: async () => ({}) }, archiveKnowledge: async () => ({}) };
  const server = await createBetaServer({ ...options, hostedPreviewOwnerId: env.CHAT_COACH_PREVIEW_OWNER_ID });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const call = (path, overrides = {}) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method: 'POST', headers: { host: env.VERCEL_URL, origin: options.publicOrigin, 'content-type': 'application/json', ...overrides } }, res => {
      let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) }));
    }); req.on('error', reject); req.end('{}');
  });
  assert.equal((await call('/api/preview/session', { host: 'public-alias.vercel.app' })).status, 403);
  assert.equal((await call('/api/preview/session', { origin: 'https://evil.test' })).status, 403);
  assert.equal(sessions, 0);
  const result = await call('/api/preview/session');
  assert.equal(result.status, 200);
  assert.equal(result.body.data.user.id, env.CHAT_COACH_PREVIEW_OWNER_ID);
  assert.match(result.headers['set-cookie'][0], /HttpOnly; SameSite=Strict; Max-Age=604800; Secure/);
  assert.equal((await call('/api/demo/session')).status, 404);
  assert.equal(sessions, 1);
  await assert.rejects(createBetaServer({ ...options, hostedPreviewOwnerId: '' }), { code: 'HOSTED_PREVIEW_CONFIGURATION_INVALID' });
});


test('Vercel path capture is removed only when it matches the entire original API pathname', () => {
  assert.equal(normalizeDeploymentUrl('/api/health?path=health'), '/api/health');
  assert.equal(normalizeDeploymentUrl('/api/counterparts/a/messages?path=counterparts%2Fa%2Fmessages'), '/api/counterparts/a/messages');
  for (const value of ['/api/health?path=me', '/api/health?path=health&token=x', '/api/health?path=health&path=health', '/api/health?x=1', '/mcp?path=mcp', '/health?path=health']) assert.equal(normalizeDeploymentUrl(value), value);
});
