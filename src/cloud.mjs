import { Pool } from 'pg';
import { createBetaServer } from './beta-api.mjs';
import { createBetaMcpHandler } from './beta-mcp.mjs';
import { createPostgresStore } from './postgres-store.mjs';
import { createPostgresKnowledgeStore, archivePostgresKnowledgeVersion } from './postgres-knowledge.mjs';

// This owner workspace is published only as a Vercel-authenticated preview.
// Production aliases and arbitrary forwarded hosts never select its identity.
export function cloudSettings(env = process.env) {
  if (env.VERCEL !== '1' || env.VERCEL_ENV !== 'preview') throw new Error('PRIVATE_PREVIEW_REQUIRED');
  const host = env.VERCEL_URL;
  if (typeof host !== 'string' || !/^[a-z0-9][a-z0-9-]*\.vercel\.app$/.test(host)) throw new Error('DEPLOYMENT_HOST_REQUIRED');
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(env.CHAT_COACH_PREVIEW_OWNER_ID ?? '')) throw new Error('PREVIEW_OWNER_REQUIRED');
  const connection = new URL(env.CHAT_COACH_DATABASE_URL ?? '');
  if (connection.protocol !== 'postgresql:' || !connection.hostname.endsWith('.pooler.supabase.com') || connection.port !== '6543' || connection.pathname !== '/postgres' || decodeURIComponent(connection.username) !== 'chat_coach_app.eucsgmsalvgqjfeazcyp' || !connection.password || connection.search) throw new Error('PRIVATE_DATABASE_REQUIRED');
  const limits = Object.fromEntries(['FREE', 'PAID', 'GLOBAL'].map((type) => {
    const value = Number(env[`CHAT_COACH_${type}_PROVIDER_DAILY_LIMIT`] ?? (type === 'GLOBAL' ? 100 : 10));
    if (!Number.isSafeInteger(value) || value < 1 || value > 10000) throw new Error('PROVIDER_LIMIT_INVALID');
    return [`${type.toLowerCase()}ProviderDailyLimit`, value];
  }));
  return { host, origin: `https://${host}`, databaseUrl: connection.toString(), ownerId: env.CHAT_COACH_PREVIEW_OWNER_ID, ...limits };
}

export function acceptsDeploymentRequest(req, host) {
  return req.headers.host === host;
}

// Vercel forwards the unused :path* rewrite capture as ?path=... while
// retaining the original pathname. Remove only that exact routing artifact;
// arbitrary client query strings keep the API's existing rejection behavior.
export function normalizeDeploymentUrl(value) {
  const url = new URL(value, 'https://routing.invalid');
  if (url.pathname.startsWith('/api/') && url.searchParams.size === 1 &&
      url.searchParams.get('path') === decodeURIComponent(url.pathname.slice(5))) {
    return url.pathname;
  }
  return value;
}

export async function createCloudHandler({ env = process.env, attachPool = () => {}, poolFactory = (options) => new Pool(options) } = {}) {
  const settings = cloudSettings(env);
  const pool = poolFactory({ connectionString: settings.databaseUrl, ssl: { rejectUnauthorized: true, ...(env.CHAT_COACH_DATABASE_CA ? { ca: env.CHAT_COACH_DATABASE_CA } : {}) }, max: 4,
    idleTimeoutMillis: 5000, connectionTimeoutMillis: 10000, application_name: 'wechat-chat-coach' });
  // Vercel drains idle connections before suspension; PG retains all durable state.
  attachPool(pool);
  try {
    const store = await createPostgresStore({ pool, ...settings });
    const owner = await store.getUser(settings.ownerId);
    if (owner.role !== 'owner') throw new Error('PREVIEW_OWNER_REQUIRED');
    const knowledge = createPostgresKnowledgeStore({ pool, readCurrent: () => store.getCurrentKnowledgeVersion() });
    await knowledge.read();
    const server = await createBetaServer({ store, publicOrigin: settings.origin, webDir: null,
      hostedPreviewOwnerId: settings.ownerId, storeKnowledge: knowledge, providerEnv: env,
      archiveKnowledge: (snapshot) => archivePostgresKnowledgeVersion(pool, snapshot) });
    server.setMcpHandler(createBetaMcpHandler(server));
    const handle = server.listeners('request')[0];
    const handler = async (req, res) => {
      if (!acceptsDeploymentRequest(req, settings.host)) {
        res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: { code: 'HOST_FORBIDDEN', message: '请使用受保护的预览地址。' } }));
        return;
      }
      req.url = normalizeDeploymentUrl(req.url);
      return await handle(req, res);
    };
    handler.close = async () => { await pool.end(); };
    return handler;
  } catch (error) { await pool.end(); throw error; }
}
