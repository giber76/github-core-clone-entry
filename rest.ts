// rest.ts — GitHub REST v3 surface under /api/v3. Every reply is application/json
// with a non-empty X-GitHub-Request-Id; errors carry {message}. Follows
// gcc-spec-rest.md: auth (missing token -> 401, other owner -> 404 never 403),
// repos, branches, commits, contents, labels, issues, pulls, pagination via Link.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseTree as parseTreeExport } from './git-core.ts';
import {
  blobAtPath,
  commitFile,
  createIssue,
  createPullRequest,
  createRepo,
  deleteFile,
  deleteRepo,
  flattenTree,
  getRepo,
  listCommits,
  listRepos,
  mergePullRequest,
  prConflicts,
  refTip,
  resolveRef,
  StoreError,
  treeOfCommit,
  VIEWER_LOGIN,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';
import { parseJsonBody, sendError, sendJson } from './http-util.ts';

const BASE64_STRIP = /[\r\n\t ]/g;

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.dbId * 100000 + issue.number,
    node_id: issue.gid,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: 'ededed' })),
    user: { login: VIEWER_LOGIN, id: 1000 },
    comments: issue.comments.length,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: repo.dbId * 100000 + pr.number,
    node_id: pr.gid,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    head: { ref: pr.head, sha: pr.headSha, label: `${repo.owner}:${pr.head}` },
    base: { ref: pr.base, sha: pr.baseSha, label: `${repo.owner}:${pr.base}` },
    user: { login: VIEWER_LOGIN, id: 1000 },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}`,
  };
  if (pr.merged) {
    base.merged = true;
    base.merged_at = pr.mergedAt;
    base.merge_commit_sha = pr.mergeCommitSha;
  } else {
    base.merged = false;
    base.mergeable = !prConflicts(repo, pr);
  }
  return base;
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: `R-${repo.dbId}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000 },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
  };
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  body: Buffer;
  url: URL;
  segments: string[];
}

function originOf(ctx: Ctx): string {
  const host = ctx.req.headers.host ?? 'localhost';
  return `http://${host}`;
}

function pageParams(ctx: Ctx): { perPage: number; page: number } {
  const perPage = Math.max(1, Number.parseInt(ctx.url.searchParams.get('per_page') ?? '30', 10) || 30);
  const page = Math.max(1, Number.parseInt(ctx.url.searchParams.get('page') ?? '1', 10) || 1);
  return { perPage, page };
}

/** Paginate `items`, sending the GitHub-style Link header when another page exists. */
function paginate<T>(ctx: Ctx, items: T[]): T[] {
  const { perPage, page } = pageParams(ctx);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (start + perPage < items.length) {
    const next = `${originOf(ctx)}${ctx.url.pathname}?per_page=${perPage}&page=${page + 1}`;
    ctx.res.setHeader('Link', `<${next}>; rel="next"`);
  }
  return slice;
}

/** Parse a JSON body; a malformed JSON body is 400 (protocol.malformed-body-400). */
function jsonBody(ctx: Ctx): { ok: true; value: Record<string, unknown> } | { ok: false } {
  const parsed = parseJsonBody(ctx.body);
  if (!parsed.ok) {
    sendError(ctx.res, 400, 'malformed JSON body');
    return { ok: false };
  }
  const value = parsed.value;
  if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
    sendError(ctx.res, 400, 'body must be a JSON object');
    return { ok: false };
  }
  return { ok: true, value: (value ?? {}) as Record<string, unknown> };
}

/** Load the repo named by the path, enforcing owner == viewer (else 404, never 403). */
function loadRepo(ctx: Ctx, owner: string, name: string): Repo | null {
  const repo = getRepo(owner, name);
  if (repo === undefined || repo.owner !== VIEWER_LOGIN) {
    sendError(ctx.res, 404, 'repository not found');
    return null;
  }
  return repo;
}

export function handleRest(ctx: Ctx): boolean {
  const seg = ctx.segments;
  if (seg.length === 0 || seg[0] !== 'api' || seg[1] !== 'v3') return false;
  const rest = seg.slice(2);
  try {
    route(ctx, rest);
  } catch (err) {
    if (err instanceof StoreError) {
      sendError(ctx.res, err.status, err.message);
    } else {
      sendError(ctx.res, 500, err instanceof Error ? err.message : 'internal error');
    }
  }
  return true;
}

function route(ctx: Ctx, rest: string[]): void {
  const { req, res } = ctx;
  const method = req.method ?? 'GET';

  // Root and meta.
  if (rest.length === 0 || (rest.length === 1 && rest[0] === '')) {
    if (method !== 'GET') return sendError(res, 404, 'not found');
    return sendJson(res, 200, { message: 'github-core-clone' }, { 'x-oauth-scopes': 'repo, user' });
  }
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') return sendError(res, 404, 'not found');
    return sendJson(res, 200, { installed_version: '1.0.0' });
  }

  // /user/repos — POST (create) and GET (paginated list).
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      const parsed = jsonBody(ctx);
      if (!parsed.ok) return;
      const name = parsed.value.name;
      if (typeof name !== 'string' || name === '') return sendError(res, 422, 'name is required');
      const repo = createRepo(
        VIEWER_LOGIN,
        name,
        parsed.value.private === true,
        typeof parsed.value.description === 'string' ? parsed.value.description : '',
      );
      if (repo === null) return sendError(res, 422, 'repository already exists');
      return sendJson(res, 201, repoJson(repo));
    }
    if (method === 'GET') {
      const all = listRepos(VIEWER_LOGIN).map((r) => repoJson(r));
      return sendJson(res, 200, paginate(ctx, all));
    }
    return sendError(res, 404, 'not found');
  }

  // /repos/{owner}/{repo}/...
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = decodeURIComponent(rest[1]);
    const name = decodeURIComponent(rest[2]);
    const tail = rest.slice(3);
    return routeRepo(ctx, owner, name, tail);
  }

  // Unknown /api/v3 route -> JSON 404.
  return sendError(res, 404, 'not found');
}

function routeRepo(ctx: Ctx, owner: string, name: string, tail: string[]): void {
  const { req, res } = ctx;
  const method = req.method ?? 'GET';

  // /repos/{o}/{r} itself: GET / PATCH / DELETE.
  if (tail.length === 0) {
    if (method === 'GET') {
      const repo = loadRepo(ctx, owner, name);
      if (repo === null) return;
      return sendJson(res, 200, repoJson(repo));
    }
    if (method === 'PATCH') {
      const repo = loadRepo(ctx, owner, name);
      if (repo === null) return;
      const parsed = jsonBody(ctx);
      if (!parsed.ok) return;
      if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
      return sendJson(res, 200, repoJson(repo));
    }
    if (method === 'DELETE') {
      const repo = loadRepo(ctx, owner, name);
      if (repo === null) return;
      deleteRepo(owner, name);
      res.writeHead(204, { 'x-github-request-id': 'req-delete' });
      res.end();
      return;
    }
    return sendError(res, 404, 'not found');
  }

  const repo = loadRepo(ctx, owner, name);
  if (repo === null) return;

  // Branches and refs.
  if (tail.length === 1 && tail[0] === 'branches' && method === 'GET') {
    const branches: Record<string, unknown>[] = [];
    for (const [ref, sha] of repo.refs) {
      if (!ref.startsWith('refs/heads/')) continue;
      branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
    }
    branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return sendJson(res, 200, branches);
  }
  if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs' && method === 'POST') {
    const parsed = jsonBody(ctx);
    if (!parsed.ok) return;
    const ref = parsed.value.ref;
    const sha = parsed.value.sha;
    if (typeof ref !== 'string' || typeof sha !== 'string' || !ref.startsWith('refs/heads/')) {
      return sendError(res, 422, 'ref and sha are required');
    }
    repo.refs.set(ref, sha);
    return sendJson(res, 201, { ref, object: { sha } });
  }

  // Commits.
  if (tail.length === 1 && tail[0] === 'commits' && method === 'GET') {
    const shaParam = ctx.url.searchParams.get('sha') ?? undefined;
    const tip = resolveRef(repo, shaParam);
    if (tip === undefined) return sendJson(res, 200, []);
    const commits = listCommits(repo, tip).map((c) => ({
      sha: c.sha,
      commit: { message: c.message },
    }));
    return sendJson(res, 200, commits);
  }

  // Contents.
  if (tail[0] === 'contents') {
    return routeContents(ctx, repo, tail.slice(1));
  }

  // Labels.
  if (tail.length === 1 && tail[0] === 'labels') {
    if (method === 'POST') {
      const parsed = jsonBody(ctx);
      if (!parsed.ok) return;
      const labelName = parsed.value.name;
      if (typeof labelName !== 'string' || labelName === '') return sendError(res, 422, 'name is required');
      const color = typeof parsed.value.color === 'string' ? parsed.value.color : 'ededed';
      repo.labels.set(labelName, { name: labelName, color });
      return sendJson(res, 201, { name: labelName, color });
    }
    if (method === 'GET') {
      return sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })));
    }
    return sendError(res, 404, 'not found');
  }

  // Issues.
  if (tail[0] === 'issues') {
    return routeIssues(ctx, repo, tail.slice(1));
  }

  // Pulls.
  if (tail[0] === 'pulls') {
    return routePulls(ctx, repo, tail.slice(1));
  }

  return sendError(res, 404, 'not found');
}

function routeContents(ctx: Ctx, repo: Repo, pathSegs: string[]): void {
  const { req, res } = ctx;
  const method = req.method ?? 'GET';
  const path = pathSegs.map((s) => decodeURIComponent(s)).join('/');
  const refParam = ctx.url.searchParams.get('ref') ?? undefined;

  if (method === 'GET') {
    const tip = resolveRef(repo, refParam);
    if (tip === undefined) return sendError(res, 404, 'file not found');
    const tree = treeOfCommit(repo, tip);
    if (tree === undefined) return sendError(res, 404, 'file not found');
    const flat = flattenTree(repo, tree);
    const blob = flat.get(path);
    if (blob !== undefined) {
      const content = repo.objects.get(blob.oid)?.data ?? Buffer.alloc(0);
      return sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        content: content.toString('base64'),
        sha: blob.oid,
        size: content.length,
        name: path.split('/').pop() ?? '',
        path,
      });
    }
    // Directory listing: immediate children of `path` in the tree.
    const children = new Map<string, { type: string; sha: string }>();
    // Walk the tree structure (not the flattened map) to find direct children.
    const collectChildren = (treeOid: string, current: string): void => {
      const obj = repo.objects.get(treeOid);
      if (obj === undefined || obj.type !== 'tree') return;
      for (const entry of parseTreeExport(obj.data)) {
        const childPath = current === '' ? entry.name : `${current}/${entry.name}`;
        if (current === path) {
          children.set(entry.name, { type: entry.mode === '40000' ? 'dir' : 'file', sha: entry.oid });
        } else if (path.startsWith(childPath + '/') || childPath === path) {
          if (entry.mode === '40000') collectChildren(entry.oid, childPath);
        }
      }
    };
    if (path === '') {
      collectChildren(tree, '');
    } else {
      // Find the subtree at `path`.
      const findTree = (treeOid: string, current: string): string | null => {
        if (current === path) return treeOid;
        const obj = repo.objects.get(treeOid);
        if (obj === undefined || obj.type !== 'tree') return null;
        for (const entry of parseTreeExport(obj.data)) {
          if (entry.mode !== '40000') continue;
          const childPath = current === '' ? entry.name : `${current}/${entry.name}`;
          if (path === childPath || path.startsWith(childPath + '/')) {
            return findTree(entry.oid, childPath);
          }
        }
        return null;
      };
      const sub = findTree(tree, '');
      if (sub === null) return sendError(res, 404, 'file not found');
      collectChildren(sub, path);
    }
    const items = [...children.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([itemName, info]) => ({
        type: info.type,
        name: itemName,
        path: path === '' ? itemName : `${path}/${itemName}`,
        sha: info.sha,
      }));
    return sendJson(res, 200, items);
  }

  if (method === 'PUT') {
    const parsed = jsonBody(ctx);
    if (!parsed.ok) return;
    const message = parsed.value.message;
    const content = parsed.value.content;
    if (typeof message !== 'string' || typeof content !== 'string') {
      return sendError(res, 422, 'message and content are required');
    }
    const bytes = Buffer.from(content.replace(BASE64_STRIP, ''), 'base64');
    const branch = typeof parsed.value.branch === 'string' ? parsed.value.branch : undefined;
    const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : undefined;
    const tip = resolveRef(repo, branch);
    const exists = tip !== undefined && blobAtPath(repo, tip, path) !== undefined;
    if (exists && sha === undefined) return sendError(res, 422, 'sha is required to update a file');
    try {
      const result = commitFile(repo, { branch, path, content: bytes, message, expectedSha: sha });
      return sendJson(res, exists ? 200 : 201, {
        content: { sha: result.blobSha, encoding: 'base64' },
        commit: { sha: result.commitSha },
      });
    } catch (err) {
      if (err instanceof StoreError) return sendError(res, err.status, err.message);
      throw err;
    }
  }

  if (method === 'DELETE') {
    const parsed = jsonBody(ctx);
    if (!parsed.ok) return;
    const message = typeof parsed.value.message === 'string' ? parsed.value.message : '';
    const sha = parsed.value.sha;
    if (typeof sha !== 'string') return sendError(res, 422, 'sha is required');
    try {
      const commitSha = deleteFile(repo, path, message, sha);
      return sendJson(res, 200, { commit: { sha: commitSha } });
    } catch (err) {
      if (err instanceof StoreError) return sendError(res, err.status, err.message);
      throw err;
    }
  }

  return sendError(res, 404, 'not found');
}

function routeIssues(ctx: Ctx, repo: Repo, tail: string[]): void {
  const { req, res } = ctx;
  const method = req.method ?? 'GET';

  // /issues — list / create.
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = ctx.url.searchParams.get('state') ?? 'open';
      const sort = ctx.url.searchParams.get('sort');
      const direction = ctx.url.searchParams.get('direction') ?? 'asc';
      let items = repo.issues.filter((i) => state === 'all' || i.state === state);
      if (sort === 'created') {
        items = [...items].sort((a, b) => (direction === 'desc' ? b.seq - a.seq : a.seq - b.seq));
      }
      return sendJson(res, 200, paginate(ctx, items.map((i) => issueJson(repo, i))));
    }
    if (method === 'POST') {
      const parsed = jsonBody(ctx);
      if (!parsed.ok) return;
      const title = parsed.value.title;
      if (typeof title !== 'string') return sendError(res, 422, 'title is required');
      const body = typeof parsed.value.body === 'string' ? parsed.value.body : '';
      const labels = Array.isArray(parsed.value.labels)
        ? parsed.value.labels.filter((l): l is string => typeof l === 'string')
        : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return sendError(res, 422, `unknown label ${label}`);
      }
      const issue = createIssue(repo, title, body, labels);
      return sendJson(res, 201, issueJson(repo, issue));
    }
    return sendError(res, 404, 'not found');
  }

  const number = Number.parseInt(tail[0], 10);
  const issue = repo.issues.find((i) => i.number === number);
  if (tail.length === 1) {
    if (method === 'GET') {
      if (issue === undefined) return sendError(res, 404, 'issue not found');
      return sendJson(res, 200, issueJson(repo, issue));
    }
    if (method === 'PATCH') {
      if (issue === undefined) return sendError(res, 404, 'issue not found');
      const parsed = jsonBody(ctx);
      if (!parsed.ok) return;
      if (parsed.value.state === 'open' || parsed.value.state === 'closed') {
        issue.state = parsed.value.state;
      }
      return sendJson(res, 200, { number: issue.number, state: issue.state });
    }
    return sendError(res, 404, 'not found');
  }

  // /issues/{n}/comments
  if (tail.length === 2 && tail[1] === 'comments') {
    if (issue === undefined) return sendError(res, 404, 'issue not found');
    if (method === 'POST') {
      const parsed = jsonBody(ctx);
      if (!parsed.ok) return;
      if (typeof parsed.value.body !== 'string') return sendError(res, 422, 'body is required');
      const comment = { id: repo.nextCommentId, body: parsed.value.body };
      repo.nextCommentId += 1;
      issue.comments.push(comment);
      return sendJson(res, 201, { id: comment.id, body: comment.body });
    }
    if (method === 'GET') {
      return sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body })));
    }
    return sendError(res, 404, 'not found');
  }

  return sendError(res, 404, 'not found');
}

function routePulls(ctx: Ctx, repo: Repo, tail: string[]): void {
  const { req, res } = ctx;
  const method = req.method ?? 'GET';

  // /pulls — list / create.
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = ctx.url.searchParams.get('state');
      let items = repo.prs;
      if (state !== 'all') items = items.filter((p) => p.state === 'open');
      return sendJson(res, 200, paginate(ctx, items.map((p) => pullJson(repo, p))));
    }
    if (method === 'POST') {
      const parsed = jsonBody(ctx);
      if (!parsed.ok) return;
      const head = parsed.value.head;
      const base = parsed.value.base;
      const title = parsed.value.title;
      if (typeof head !== 'string' || typeof base !== 'string' || typeof title !== 'string') {
        return sendError(res, 422, 'head, base and title are required');
      }
      const body = typeof parsed.value.body === 'string' ? parsed.value.body : '';
      try {
        const pr = createPullRequest(repo, { head, base, title, body });
        return sendJson(res, 201, pullJson(repo, pr));
      } catch (err) {
        if (err instanceof StoreError) return sendError(res, err.status, err.message);
        throw err;
      }
    }
    return sendError(res, 404, 'not found');
  }

  const number = Number.parseInt(tail[0], 10);
  const pr = repo.prs.find((p) => p.number === number);

  if (tail.length === 1) {
    if (method === 'GET') {
      if (pr === undefined) return sendError(res, 404, 'pull request not found');
      return sendJson(res, 200, pullJson(repo, pr));
    }
    return sendError(res, 404, 'not found');
  }

  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    if (pr === undefined) return sendError(res, 404, 'pull request not found');
    return sendJson(
      res,
      200,
      pr.files.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
      })),
    );
  }

  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (pr === undefined) return sendError(res, 404, 'pull request not found');
    try {
      const sha = mergePullRequest(repo, pr);
      return sendJson(res, 200, { merged: true, sha, message: 'Pull request successfully merged' });
    } catch (err) {
      if (err instanceof StoreError) return sendError(res, err.status, err.message);
      throw err;
    }
  }

  return sendError(res, 404, 'not found');
}
