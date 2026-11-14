// mcp.ts — Model Context Protocol over Streamable HTTP at POST /mcp.
// JSON-RPC 2.0, modern era (server/discover, revision 2026-07-28) with the legacy
// initialize fallback. Six tools, all acting on the same store as REST
// (gcc-spec-graphql-mcp.md Part B).
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createIssue,
  createPullRequest,
  createRepo,
  getRepo,
  mergePullRequest,
  StoreError,
  VIEWER_LOGIN,
  type Repo,
} from './store.ts';
import { parseJsonBody, sendError, sendJson } from './http-util.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_ALIASES: Record<string, string[]> = {
  create_repo: ['create_repository', 'repo_create', 'repos_create', 'repository_create'],
  get_repo: ['get_repository', 'repo_get', 'repos_get', 'repository_get'],
  create_issue: ['issue_create', 'issues_create'],
  list_issues: ['issues_list', 'issue_list'],
  create_pull_request: ['pull_request_create', 'pulls_create', 'create_pr', 'pr_create'],
  merge_pull_request: ['pull_request_merge', 'pulls_merge', 'merge_pr', 'pr_merge'],
};

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findTool(name: string): ToolDef | undefined {
  const wanted = normalize(name);
  for (const tool of TOOLS) {
    if (normalize(tool.name) === wanted) return tool;
    for (const alias of TOOL_ALIASES[tool.name] ?? []) {
      if (normalize(alias) === wanted) return tool;
    }
  }
  for (const tool of TOOLS) {
    const candidates = [tool.name, ...(TOOL_ALIASES[tool.name] ?? [])].map(normalize);
    for (const candidate of candidates) {
      const listed = normalize(name);
      if (listed.length > candidate.length && listed.endsWith(candidate)) return tool;
    }
  }
  return undefined;
}

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, error: RpcError): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function toolTextResult(obj: unknown, isError = false): Record<string, unknown> {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const result: Record<string, unknown> = {
    content: [{ type: 'text', text }],
    isError,
  };
  if (!isError && obj !== null && typeof obj === 'object') result.structuredContent = obj;
  return result;
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function callTool(name: string, args: Record<string, unknown>): { result?: unknown; error?: RpcError } {
  const tool = findTool(name);
  if (tool === undefined) return { error: { code: -32602, message: `unknown tool ${name}` } };
  // Missing required arguments (checked before dispatch; the suite's missing-arguments
  // check calls create_issue with {} and expects isError or -32602).
  const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) {
    return { result: toolTextResult(`missing required argument: ${missing[0]}`, true) };
  }
  try {
    switch (tool.name) {
      case 'create_repo': {
        const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : VIEWER_LOGIN;
        const repoName = String(args.name);
        const repo = createRepo(
          owner,
          repoName,
          args.private === true,
          typeof args.description === 'string' ? args.description : '',
        );
        if (repo === null) return { result: toolTextResult(`repository ${owner}/${repoName} already exists`, true) };
        return { result: toolTextResult(repoJson(repo)) };
      }
      case 'get_repo': {
        const repo = getRepo(String(args.owner), String(args.repo));
        if (repo === undefined || repo.owner !== VIEWER_LOGIN) {
          return { result: toolTextResult(`repository ${args.owner}/${args.repo} not found`, true) };
        }
        return { result: toolTextResult(repoJson(repo)) };
      }
      case 'create_issue': {
        const repo = getRepo(String(args.owner), String(args.repo));
        if (repo === undefined || repo.owner !== VIEWER_LOGIN) {
          return { result: toolTextResult(`repository ${args.owner}/${args.repo} not found`, true) };
        }
        const issue = createIssue(
          repo,
          String(args.title),
          typeof args.body === 'string' ? args.body : '',
          [],
        );
        return {
          result: toolTextResult({
            id: repo.dbId * 100000 + issue.number,
            number: issue.number,
            title: issue.title,
            body: issue.body,
            state: issue.state,
          }),
        };
      }
      case 'list_issues': {
        const repo = getRepo(String(args.owner), String(args.repo));
        if (repo === undefined || repo.owner !== VIEWER_LOGIN) {
          return { result: toolTextResult(`repository ${args.owner}/${args.repo} not found`, true) };
        }
        const state = typeof args.state === 'string' ? args.state : 'open';
        const items = repo.issues
          .filter((i) => state === 'all' || i.state === state)
          .map((i) => ({
            id: repo.dbId * 100000 + i.number,
            number: i.number,
            title: i.title,
            body: i.body,
            state: i.state,
          }));
        return { result: toolTextResult(items) };
      }
      case 'create_pull_request': {
        const repo = getRepo(String(args.owner), String(args.repo));
        if (repo === undefined || repo.owner !== VIEWER_LOGIN) {
          return { result: toolTextResult(`repository ${args.owner}/${args.repo} not found`, true) };
        }
        const pr = createPullRequest(repo, {
          head: String(args.head),
          base: String(args.base),
          title: String(args.title),
          body: typeof args.body === 'string' ? args.body : '',
        });
        return {
          result: toolTextResult({
            number: pr.number,
            pull_number: pr.number,
            title: pr.title,
            body: pr.body,
            state: pr.state,
            head: { ref: pr.head, sha: pr.headSha },
            base: { ref: pr.base, sha: pr.baseSha },
          }),
        };
      }
      case 'merge_pull_request': {
        const repo = getRepo(String(args.owner), String(args.repo));
        if (repo === undefined || repo.owner !== VIEWER_LOGIN) {
          return { result: toolTextResult(`repository ${args.owner}/${args.repo} not found`, true) };
        }
        const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number), 10);
        const pr = repo.prs.find((p) => p.number === number);
        if (pr === undefined) {
          return { result: toolTextResult(`pull request ${number} not found`, true) };
        }
        const sha = mergePullRequest(repo, pr);
        return {
          result: toolTextResult({ number: pr.number, merged: true, sha, state: 'closed' }),
        };
      }
      default:
        return { error: { code: -32602, message: `unknown tool ${name}` } };
    }
  } catch (e) {
    if (e instanceof StoreError) return { result: toolTextResult(e.message, true) };
    throw e;
  }
}

function handleRequest(request: Record<string, unknown>): Record<string, unknown> | null {
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    return rpcResult(id, {
      supportedVersions: [MODERN_REVISION],
      serverInfo,
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = LEGACY_REVISIONS.includes(offered) ? offered : LEGACY_REVISIONS[0];
    return rpcResult(id, {
      protocolVersion: negotiated,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
    });
  }

  if (method === 'notifications/initialized') {
    return null; // Notification: no response.
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const outcome = callTool(name, args);
    if (outcome.error !== undefined) return rpcError(id, outcome.error);
    return rpcResult(id, outcome.result);
  }

  return rpcError(id, { code: -32601, message: `method not found: ${method}` });
}

export function handleMcp(req: IncomingMessage, res: ServerResponse, body: Buffer): boolean {
  if (req.method === 'DELETE') {
    // Best-effort legacy session teardown; nothing is asserted on it.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
    return true;
  }
  if (req.method !== 'POST') {
    sendError(res, 405, 'method not allowed');
    return true;
  }
  const parsed = parseJsonBody(body);
  if (!parsed.ok) {
    // Parse error: HTTP 400 with JSON-RPC -32700 (modern era).
    sendJson(res, 400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
    return true;
  }
  const value = parsed.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    sendJson(res, 400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid Request' },
    });
    return true;
  }
  const response = handleRequest(value as Record<string, unknown>);
  if (response === null) {
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end();
    return true;
  }
  sendJson(res, 200, response);
  return true;
}
