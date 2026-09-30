import test from 'node:test';
import assert from 'node:assert/strict';
import { betaSettingsFromEnv, betaListeningUrl } from '../src/beta.mjs';

test('loopback URLs match IPv4 and IPv6 while remote binding requires exact HTTPS origin', () => {
  assert.equal(betaListeningUrl(betaSettingsFromEnv({})), 'http://127.0.0.1:8788');
  assert.equal(betaListeningUrl(betaSettingsFromEnv({ CHAT_COACH_BETA_HOST: '::1' })), 'http://[::1]:8788');
  const local = betaSettingsFromEnv({ CHAT_COACH_BETA_HOST: '::1', CHAT_COACH_PUBLIC_ORIGIN: 'http://[::1]:8788' });
  assert.equal(betaListeningUrl(local), 'http://[::1]:8788');
  assert.throws(() => betaSettingsFromEnv({ CHAT_COACH_BETA_HOST: '0.0.0.0' }), /PUBLIC_ORIGIN_REQUIRED/);
  assert.throws(() => betaSettingsFromEnv({ CHAT_COACH_BETA_HOST: '0.0.0.0', CHAT_COACH_PUBLIC_ORIGIN: 'http://external.example' }), /HTTPS_ORIGIN_REQUIRED/);
  assert.throws(() => betaSettingsFromEnv({ CHAT_COACH_PUBLIC_ORIGIN: 'https://external.example/path' }), /HTTPS_ORIGIN_REQUIRED/);
});

test('direct demo startup is explicit, local and uses a distinct default data directory', () => {
  const demo = betaSettingsFromEnv({ CHAT_COACH_LOCAL_DEMO: '1' });
  assert.equal(demo.localDemoMode, true);
  assert.ok(demo.dataDir.endsWith('/data/local-demo'));
  assert.notEqual(demo.dataDir, betaSettingsFromEnv({}).dataDir);
  assert.throws(() => betaSettingsFromEnv({ CHAT_COACH_LOCAL_DEMO: '1', CHAT_COACH_BETA_HOST: '0.0.0.0' }), /LOCAL_DEMO_ONLY/);
  assert.throws(() => betaSettingsFromEnv({ CHAT_COACH_LOCAL_DEMO: '1', CHAT_COACH_PUBLIC_ORIGIN: 'https://demo.example' }), /LOCAL_DEMO_ONLY/);
  assert.throws(() => betaSettingsFromEnv({ CHAT_COACH_LOCAL_DEMO: 'true' }), /DEMO_MODE_INVALID/);
});
