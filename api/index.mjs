import { attachDatabasePool } from '@vercel/functions';
import { createCloudHandler } from '../src/cloud.mjs';

let ready;
export default async function handler(req, res) {
  try {
    if (!ready) ready = createCloudHandler({ attachPool: attachDatabasePool }).catch((error) => { ready = undefined; throw error; });
    return await (await ready)(req, res);
  } catch {
    // Never send connection strings, provider errors or knowledge to deployment logs.
    if (!res.headersSent) res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    if (!res.writableEnded) res.end(JSON.stringify({ error: { code: 'CLOUD_UNAVAILABLE', message: '工作区暂时无法连接，请稍后重试。' } }));
  }
}
