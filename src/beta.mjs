import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBetaServer } from './beta-api.mjs';
import { createBetaMcpHandler } from './beta-mcp.mjs';

export function betaSettingsFromEnv(env = process.env) {
  const port = Number(env.CHAT_COACH_BETA_PORT ?? 8788);
  const host = env.CHAT_COACH_BETA_HOST ?? '127.0.0.1';
  const publicOrigin = env.CHAT_COACH_PUBLIC_ORIGIN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT_INVALID');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !publicOrigin) throw new Error('PUBLIC_ORIGIN_REQUIRED');
  if (publicOrigin) {
    const origin = new URL(publicOrigin);
    const localProxy = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) && origin.protocol === 'http:';
    if ((origin.protocol !== 'https:' && !localProxy) || origin.origin !== publicOrigin || origin.username || origin.password) throw new Error('HTTPS_ORIGIN_REQUIRED');
  }
  const limits = {
    freeProviderDailyLimit: Number(env.CHAT_COACH_FREE_PROVIDER_DAILY_LIMIT ?? 10),
    paidProviderDailyLimit: Number(env.CHAT_COACH_PAID_PROVIDER_DAILY_LIMIT ?? 10),
    globalProviderDailyLimit: Number(env.CHAT_COACH_GLOBAL_PROVIDER_DAILY_LIMIT ?? 100),
  };
  for (const limit of Object.values(limits)) if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error('PROVIDER_LIMIT_INVALID');
  return {
    host, port, publicOrigin,
    dataDir: resolve(env.CHAT_COACH_DATA_DIR ?? 'data/beta'),
    webDir: resolve('dist/public'),
    ...limits,
  };
}

export function betaListeningUrl({ host, port, publicOrigin }) {
  return publicOrigin ?? `http://${host === '::1' ? '[::1]' : host}:${port}`;
}

async function main() {
  if (process.argv.length > 2) throw new Error('STARTUP_ARGUMENTS_INVALID');
  process.umask(0o077);
  const { host, port, ...options } = betaSettingsFromEnv();
  const server = await createBetaServer(options);
  server.setMcpHandler(createBetaMcpHandler(server));
  await new Promise((done, failed) => { server.once('error', failed); server.listen(port, host, done); });
  console.log(`Chat coach beta is listening at ${betaListeningUrl({ host, port, ...options })}.`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.close(() => { process.exitCode = 0; });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write('Beta startup failed. Check private configuration, build and data directory.\n'); process.exitCode = 1; });
}
