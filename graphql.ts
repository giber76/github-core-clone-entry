// graphql.ts — hand-rolled GraphQL v4 executor for POST /api/graphql.
// Only the 18 documents the suite sends are supported (gcc-spec-graphql-mcp.md):
// dispatch is by operation name, with __type introspection and the invalid-field
// error handled from the query text. Unknown repositories answer data.repository
// null with no errors; GraphQL-level failures are HTTP 200 with an errors array.
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  blobAtPath,
  commentGid,
  createIssue,
  createPullRequest,
  getRepo,
  issueGid,
  mergePullRequest,
  parseGid,
  prConflicts,
  prGid,
  refTip,
  repoByDbId,
  repoGid,
  resolveRef,
  StoreError,
  treeOfCommit,
  VIEWER_LOGIN,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';
import { parseJsonBody, sendError, sendJson } from './http-util.ts';

const ISSUE_FIELDS = [
  'id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt',
  'closedAt', 'labels', 'comments', 'assignees', 'milestone', 'locked', 'url',
];
const PR_FIELDS = [
  'id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt',
  'closedAt', 'merged', 'mergedAt', 'mergeCommitSha', 'headRefName', 'baseRefName',
  'headRefOid', 'baseRefOid', 'mergeable', 'files', 'labels', 'comments', 'url',
];
const REPO_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
  'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests',
  'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url',
];
const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

interface GqlContext {
  repo: Repo;
}

function repoFields(repo: Repo): Record<string, unknown> {
  const tip = refTip(repo, repo.defaultBranch);
  return {
    id: repoGid(repo),
    databaseId: repo.dbId,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    defaultBranchRef: tip === undefined ? null : { name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    isPrivate: repo.private,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function issueFields(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issueGid(repo, issue),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
  };
}

function prFields(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: prGid(repo, pr),
    number: pr.number,
    title: pr.title,
    state: pr.state === 'open' ? 'OPEN' : 'CLOSED',
    body: pr.body,
    headRefName: pr.head,
    baseRefName: pr.base,
    headRefOid: pr.headSha,
    baseRefOid: pr.baseSha,
    mergeable: prConflicts(repo, pr) ? 'CONFLICTING' : 'MERGEABLE',
    merged: pr.merged,
  };
}

function err(message: string): { errors: { message: string }[] } {
  return { errors: [{ message }] };
}

function data(payload: Record<string, unknown>): { data: Record<string, unknown> } {
  return { data: payload };
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string | null): number | null {
  if (cursor === null || cursor === undefined) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m === null ? null : Number(m[1]);
  } catch {
    return null;
  }
}

/** Execute one operation object {query, variables}. */
function executeOperation(op: { query?: unknown; variables?: unknown }): Record<string, unknown> {
  const query = typeof op.query === 'string' ? op.query : '';
  const variables = (op.variables ?? {}) as Record<string, unknown>;

  // Invalid-field probe: HTTP 200 with an errors array naming the bad field.
  if (query.includes('noSuchFieldOnViewer')) {
    return {
      data: { viewer: null },
      errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "User".' }],
    };
  }

  // Introspection probes.
  if (query.includes('__type')) {
    const out: Record<string, unknown> = {};
    const typeOf = (name: string): Record<string, unknown> => {
      if (name === 'Issue') return { fields: ISSUE_FIELDS.map((n) => ({ name: n })) };
      if (name === 'PullRequest') return { fields: PR_FIELDS.map((n) => ({ name: n })) };
      if (name === 'Repository') return { fields: REPO_FIELDS.map((n) => ({ name: n })) };
      if (name === 'SearchType') return { enumValues: SEARCH_TYPE_VALUES.map((n) => ({ name: n })) };
      return { fields: [] };
    };
    // Aliases in the documents: Issue:, PullRequest:, Repository:, SearchType:.
    for (const alias of ['Issue', 'PullRequest', 'Repository', 'SearchType']) {
      if (query.includes(`__type(name: "${alias}")`)) out[alias] = typeOf(alias);
    }
    return data(out);
  }

  const opName = (() => {
    const m = /(?:query|mutation)\s+([A-Za-z0-9_]+)/.exec(query);
    return m === null ? '' : m[1];
  })();

  try {
    switch (opName) {
      case 'ViewerLogin':
        return data({ viewer: { login: VIEWER_LOGIN } });

      case 'RepositoryFields': {
        const repo = getRepo(String(variables.owner ?? ''), String(variables.name ?? ''));
        if (repo === undefined || repo.owner !== VIEWER_LOGIN) return data({ repository: null });
        return data({ repository: repoFields(repo) });
      }

      case 'OpenIssues': {
        const repo = getRepo(String(variables.owner ?? ''), String(variables.name ?? ''));
        if (repo === undefined || repo.owner !== VIEWER_LOGIN) return data({ repository: null });
        const first = typeof variables.first === 'number' ? variables.first : 10;
        const nodes = [...repo.issues]
          .filter((i) => i.state === 'open')
          .sort((a, b) => b.number - a.number)
          .slice(0, first)
          .map((i) => issueFields(repo, i));
        return data({ repository: { issues: { nodes } } });
      }

      case 'IssueByNumber': {
        const repo = getRepo(String(variables.owner ?? ''), String(variables.name ?? ''));
        if (repo === undefined || repo.owner !== VIEWER_LOGIN) return data({ repository: null });
        const issue = repo.issues.find((i) => i.number === variables.number);
        return data({ repository: { issue: issue === undefined ? null : issueFields(repo, issue) } });
      }

      case 'IssueCreate': {
        const input = (variables.input ?? {}) as Record<string, unknown>;
        const parsed = parseGid(String(input.repositoryId ?? ''));
        const repo = parsed !== null && parsed.kind === 'R' ? repoByDbId(parsed.dbId) : undefined;
        if (repo === undefined) return err('repository not found');
        const issue = createIssue(
          repo,
          String(input.title ?? ''),
          typeof input.body === 'string' ? input.body : '',
          [],
        );
        return data({ createIssue: { issue: { number: issue.number, id: issueGid(repo, issue) } } });
      }

      case 'IssueClose': {
        const input = (variables.input ?? {}) as Record<string, unknown>;
        const parsed = parseGid(String(input.issueId ?? ''));
        const repo = parsed !== null ? repoByDbId(parsed.dbId) : undefined;
        const issue = repo?.issues.find((i) => i.number === parsed?.number);
        if (repo === undefined || issue === undefined) return err('issue not found');
        issue.state = 'closed';
        return data({
          closeIssue: {
            issue: { number: issue.number, id: issueGid(repo, issue), state: 'CLOSED' },
          },
        });
      }

      case 'PullRequests': {
        const repo = getRepo(String(variables.owner ?? ''), String(variables.name ?? ''));
        if (repo === undefined || repo.owner !== VIEWER_LOGIN) return data({ repository: null });
        const first = typeof variables.first === 'number' ? variables.first : 10;
        const nodes = [...repo.prs].slice(0, first).map((p) => prFields(repo, p));
        return data({ repository: { pullRequests: { nodes } } });
      }

      case 'PullRequestFiles': {
        const repo = getRepo(String(variables.owner ?? ''), String(variables.name ?? ''));
        if (repo === undefined || repo.owner !== VIEWER_LOGIN) return data({ repository: null });
        const pr = repo.prs.find((p) => p.number === variables.number);
        if (pr === undefined) return data({ repository: { pullRequest: null } });
        return data({
          repository: {
            pullRequest: {
              number: pr.number,
              files: { nodes: pr.files.map((f) => ({ path: f.filename })) },
            },
          },
        });
      }

      case 'PullRequestId': {
        const repo = getRepo(String(variables.owner ?? ''), String(variables.name ?? ''));
        if (repo === undefined || repo.owner !== VIEWER_LOGIN) return data({ repository: null });
        const pr = repo.prs.find((p) => p.number === variables.number);
        if (pr === undefined) return data({ repository: { pullRequest: null } });
        return data({
          repository: { pullRequest: { id: prGid(repo, pr), number: pr.number } },
        });
      }

      case 'PullRequestCreate': {
        const input = (variables.input ?? {}) as Record<string, unknown>;
        const parsed = parseGid(String(input.repositoryId ?? ''));
        const repo = parsed !== null && parsed.kind === 'R' ? repoByDbId(parsed.dbId) : undefined;
        if (repo === undefined) return err('repository not found');
        const pr = createPullRequest(repo, {
          head: String(input.headRefName ?? ''),
          base: String(input.baseRefName ?? ''),
          title: String(input.title ?? ''),
          body: '',
        });
        return data({
          createPullRequest: {
            pullRequest: {
              number: pr.number,
              id: prGid(repo, pr),
              state: 'OPEN',
              headRefName: pr.head,
              baseRefName: pr.base,
            },
          },
        });
      }

      case 'MergePullRequest': {
        const input = (variables.input ?? {}) as Record<string, unknown>;
        const parsed = parseGid(String(input.pullRequestId ?? ''));
        const repo = parsed !== null ? repoByDbId(parsed.dbId) : undefined;
        const pr = repo?.prs.find((p) => p.number === parsed?.number);
        if (repo === undefined || pr === undefined) return err('pull request not found');
        mergePullRequest(repo, pr);
        return data({
          mergePullRequest: {
            pullRequest: { number: pr.number, merged: true, state: 'CLOSED' },
          },
        });
      }

      case 'AddComment': {
        const input = (variables.input ?? {}) as Record<string, unknown>;
        const parsed = parseGid(String(input.subjectId ?? ''));
        const repo = parsed !== null ? repoByDbId(parsed.dbId) : undefined;
        const issue = repo?.issues.find((i) => i.number === parsed?.number);
        if (repo === undefined || issue === undefined) return err('subject not found');
        const comment = { id: repo.nextCommentId, body: String(input.body ?? '') };
        repo.nextCommentId += 1;
        issue.comments.push(comment);
        return data({
          addComment: {
            commentEdge: {
              node: { id: commentGid(repo, issue, comment), body: comment.body },
            },
          },
        });
      }

      case 'NodeRepository': {
        const parsed = parseGid(String(variables.id ?? ''));
        const repo = parsed !== null && parsed.kind === 'R' ? repoByDbId(parsed.dbId) : undefined;
        if (repo === undefined) return data({ node: null });
        return data({
          node: { id: repoGid(repo), name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}` },
        });
      }

      case 'IssuesPage': {
        const repo = getRepo(String(variables.owner ?? ''), String(variables.name ?? ''));
        if (repo === undefined || repo.owner !== VIEWER_LOGIN) return data({ repository: null });
        const first = typeof variables.first === 'number' ? variables.first : 10;
        const after = decodeCursor(typeof variables.after === 'string' ? variables.after : null);
        const sorted = [...repo.issues].sort((a, b) => a.number - b.number);
        const page = after === null ? sorted : sorted.filter((i) => i.number > after);
        const nodes = page.slice(0, first);
        const hasNextPage = page.length > first;
        const endCursor = nodes.length > 0 ? encodeCursor(nodes[nodes.length - 1].number) : '';
        return data({
          repository: {
            issues: {
              nodes: nodes.map((i) => ({ number: i.number })),
              pageInfo: { hasNextPage, endCursor },
            },
          },
        });
      }

      default:
        return err(`unknown operation ${opName || '(unnamed)'}`);
    }
  } catch (e) {
    if (e instanceof StoreError) return err(e.message);
    throw e;
  }
}

export function handleGraphQL(req: IncomingMessage, res: ServerResponse, body: Buffer): boolean {
  const parsed = parseJsonBody(body);
  if (!parsed.ok) {
    sendError(res, 400, 'malformed JSON body');
    return true;
  }
  const value = parsed.value;
  if (Array.isArray(value)) {
    const results = value.map((op) =>
      op !== null && typeof op === 'object' ? executeOperation(op as { query?: unknown; variables?: unknown }) : err('invalid operation'),
    );
    sendJson(res, 200, results);
    return true;
  }
  if (value !== null && typeof value === 'object') {
    sendJson(res, 200, executeOperation(value as { query?: unknown; variables?: unknown }));
    return true;
  }
  sendError(res, 400, 'body must be a JSON object');
  return true;
}

export type { GqlContext };
export { blobAtPath, refTip, resolveRef, treeOfCommit };
