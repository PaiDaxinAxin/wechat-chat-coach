import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { z } from 'zod';
import packageMetadata from '../package.json' with { type: 'json' };

const Id = z.string().trim().min(1).max(100);
const RequestId = z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/);
const Context = { counterpartId: Id, requestId: RequestId.optional() };
const SAFE_CODES = new Set([
  'NOT_FOUND', 'UNAUTHORIZED', 'FORBIDDEN', 'INPUT_INVALID', 'INVALID_INPUT',
  'PROFILE_REQUIRED', 'CONTEXT_REQUIRED', 'CLASSIFICATION_QUOTA_EXHAUSTED', 'DAILY_REPLY_QUOTA_EXHAUSTED',
  'COUNTERPART_NOT_FOUND', 'SUGGESTION_NOT_FOUND', 'PROVIDER_BUDGET_EXHAUSTED',
  'REQUEST_ID_CONTEXT_CONFLICT', 'JOB_NOT_AVAILABLE', 'JOB_INTERRUPTED',
  'PROFILE_REQUIRES_SHORT_QUESTIONNAIRE', 'FULL_QUESTIONNAIRE_PAID_ONLY',
  'FULL_PROFILE_REQUIRES_UPDATE', 'MODEL_OPERATION_FAILED', 'INVALID_MODEL_OUTPUT',
  'MISSING_MODEL_TOOL_CALL', 'MULTIPLE_MODEL_TOOL_CALLS', 'INVALID_MODEL_TOOL_CALL',
  'UNEXPECTED_MODEL_TOOL_CALL', 'PROVIDER_UNREACHABLE', 'INVALID_MODEL_JSON',
  'INVALID_PROVIDER_RESPONSE', 'TRUNCATED_MODEL_OUTPUT', 'MISSING_API_KEY',
  'PROVIDER_QUOTA_EXHAUSTED', 'DAILY_LIMIT_REACHED', 'JOB_IN_PROGRESS',
  'REQUEST_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'CONTEXT_CHANGED',
  'PROVIDER_TIMEOUT', 'PROVIDER_FAILED', 'MODEL_OUTPUT_INVALID',
  'OUTPUT_KNOWLEDGE_EXCERPT_BLOCKED', 'OPERATION_FAILED',
]);

function reject(res, status, code) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: { code, message: code } }));
}

async function bodyFrom(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128_000) { const error = new Error(); error.code = 'REQUEST_TOO_LARGE'; throw error; }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { const error = new Error(); error.code = 'REQUEST_INVALID'; throw error; }
}

export function createAccountMcpServer({ accountId, invoke }) {
  const server = new McpServer({ name: 'wechat-chat-coach-beta', version: packageMetadata.version });
  const operation = (method, route, transform = (input) => input) => async (input) => {
    try {
      const value = await invoke({ accountId, method, path: route(input), body: transform(input) });
      const data = value?.data ?? value;
      return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
    } catch (error) {
      const code = SAFE_CODES.has(error?.code) || /^PROVIDER_HTTP_[1-5]\d{2}$/.test(error?.code ?? '') ? error.code : 'OPERATION_FAILED';
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code } }) }] };
    }
  };
  const annotations = { destructiveHint: false, openWorldHint: true };
  server.registerTool('counterparts_list', {
    description: '列出当前账户的聊天对象及有依据的热度排序。不会读取私有体系。',
    inputSchema: z.strictObject({}), annotations: { ...annotations, readOnlyHint: true },
  }, operation('GET', () => '/api/counterparts'));
  server.registerTool('coach_classify', {
    description: '分析当前账户保存的整体场面与工作阶段；需要换话题时才给三个相对建议权重。可显式要求换话题；权重不是成功率。',
    inputSchema: z.strictObject({ ...Context, topicChangeRequested: z.boolean().optional() }), annotations,
  }, operation('POST', (input) => `/api/counterparts/${encodeURIComponent(input.counterpartId)}/classify`, (input) => ({ requestId: input.requestId ?? randomUUID(), ...(input.topicChangeRequested === undefined ? {} : { topicChangeRequested: input.topicChangeRequested }) })));
  server.registerTool('coach_reply', {
    description: '服务端用完整私有体系和当前对象上下文生成短建议。可选任一方向；不导出知识。免费分类耗尽仍可直接生成基础回复。',
    inputSchema: z.strictObject({ ...Context, direction: z.enum(['up', 'down', 'sideways']).optional(), intent: z.string().trim().min(1).max(1_000).optional(), topicChangeRequested: z.boolean().optional() }), annotations,
  }, operation('POST', (input) => `/api/counterparts/${encodeURIComponent(input.counterpartId)}/reply`, (input) => ({ requestId: input.requestId ?? randomUUID(), ...(input.direction ? { direction: input.direction } : {}), ...(input.intent ? { intent: input.intent } : {}), ...(input.topicChangeRequested === undefined ? {} : { topicChangeRequested: input.topicChangeRequested }) })));
  server.registerTool('feedback_submit', {
    description: '提交当前账户实际发送版本和后续观察，隔离为未经清理的反馈。不自动进入知识、模型上下文或训练。',
    inputSchema: z.strictObject({
      counterpartId: Id, suggestionId: Id,
      actualSentText: z.string().trim().min(1).max(2_000),
      counterpartReply: z.string().max(4_000).default(''),
      observation: z.string().trim().min(1).max(4_000),
      kind: z.enum(['positive', 'pitfall', 'uncertain']), consent: z.boolean(),
    }), annotations: { ...annotations, openWorldHint: false },
  }, operation('POST', (input) => `/api/counterparts/${encodeURIComponent(input.counterpartId)}/feedback`, ({ counterpartId: _id, ...input }) => input));
  return server;
}

/** Host/Origin policy is enforced by the containing beta server before this handler. */
export function createBetaMcpHandler(betaServer, { rateLimitPerMinute = 30, now = Date.now } = {}) {
  const windows = new Map();
  return async (req, res) => {
    const authorization = req.headers.authorization;
    if (req.headersDistinct?.authorization?.length > 1 || typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_-]{32,200}$/.test(authorization)) return reject(res, 401, 'UNAUTHORIZED');
    const user = await betaServer.betaStore.lookupMcpToken(authorization.slice(7));
    if (!user) return reject(res, 401, 'UNAUTHORIZED');
    if (!['POST', 'GET', 'DELETE'].includes(req.method)) return reject(res, 405, 'METHOD_NOT_ALLOWED');
    if (typeof betaServer.betaStore.takeRateLimit === 'function') {
      const rate = await betaServer.betaStore.takeRateLimit({ key: `mcp:${user.id}`, limit: rateLimitPerMinute, windowMs: 60_000 });
      if (!rate.allowed) return reject(res, 429, 'RATE_LIMITED');
    } else {
      const timestamp = now();
      for (const [id, entry] of windows) if (timestamp - entry.start >= 60_000) windows.delete(id);
      const window = windows.get(user.id) ?? { start: timestamp, count: 0 };
      if (++window.count > rateLimitPerMinute) return reject(res, 429, 'RATE_LIMITED');
      windows.set(user.id, window);
    }
    const server = createAccountMcpServer({ accountId: user.id, invoke: (operation) => betaServer.invokeForAccount(operation) });
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      const body = req.method === 'POST' ? await bodyFrom(req) : undefined;
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      const code = ['REQUEST_TOO_LARGE', 'REQUEST_INVALID'].includes(error?.code) ? error.code : 'MCP_REQUEST_FAILED';
      reject(res, code === 'REQUEST_TOO_LARGE' ? 413 : code === 'REQUEST_INVALID' ? 400 : 500, code);
    } finally {
      await server.close().catch(() => {});
    }
  };
}
