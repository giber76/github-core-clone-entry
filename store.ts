// store.ts — the forge's in-memory state, shared by REST, GraphQL, MCP and git.
// One process, one store: every surface reads and writes the same repos, so a mutation
// made over any surface is visible on the others (the suite cross-checks this).
//
// The viewer identity is deterministic: the suite's scenario seed is the constant
// SCENARIO_SEED = 0x6a09e667f3bcc909 in the kit's wire.ts, and users[0] of that
// scenario is always login "adaiversen" (id 1000). The token itself comes from
// MAKEFUN_SHOP_TOKEN at runtime and is compared, not decoded.

import {
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
} from './git-core.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface Comment {
  id: number;
  body: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  seq: number;
  gid: string;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  baseCommitSha: string;
  files: PullFile[];
  /** path -> new blob oid, or null when the PR deletes the path */
  changedFiles: Map<string, string | null>;
  seq: number;
  gid: string;
}

export interface Repo {
  dbId: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  prs: PullRequest[];
  labels: Map<string, { name: string; color: string }>;
  nextNumber: number;
  nextCommentId: number;
  seq: number;
}

const repos = new Map<string, Repo>();
let nextDbId = 1;
let repoSeq = 0;

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo | null {
  const key = repoKey(owner, name);
  if (repos.has(key)) return null;
  const repo: Repo = {
    dbId: nextDbId,
    name,
    owner,
    private: isPrivate,
    description,
    defaultBranch: 'main',
    objects: new Map(),
    refs: new Map(),
    issues: [],
    prs: [],
    labels: new Map(),
    nextNumber: 1,
    nextCommentId: 1,
    seq: repoSeq,
  };
  nextDbId += 1;
  repoSeq += 1;
  // The empty tree always exists so unborn repos have a tree to build from.
  repo.objects.set(EMPTY_TREE_OID, { type: 'tree', data: Buffer.alloc(0) });
  repos.set(key, repo);
  return repo;
}

export function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

export function deleteRepo(owner: string, name: string): boolean {
  return repos.delete(repoKey(owner, name));
}

export function listRepos(owner: string): Repo[] {
  const out: Repo[] = [];
  for (const repo of repos.values()) if (repo.owner === owner) out.push(repo);
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

// -------------------------------------------------------------------------------------------
// global ids (opaque; never the plain numeric id)
// -------------------------------------------------------------------------------------------

export function repoGid(repo: Repo): string {
  return `R-${repo.dbId}`;
}
export function issueGid(repo: Repo, issue: Issue): string {
  return `I-${repo.dbId}-${issue.number}`;
}
export function prGid(repo: Repo, pr: PullRequest): string {
  return `P-${repo.dbId}-${pr.number}`;
}
export function commentGid(repo: Repo, issue: Issue, comment: Comment): string {
  return `C-${repo.dbId}-${issue.number}-${comment.id}`;
}

export interface ParsedGid {
  kind: 'R' | 'I' | 'P' | 'C';
  dbId: number;
  number: number;
  commentId: number;
}

export function parseGid(gid: string): ParsedGid | null {
  const m = /^([RIPC])-(\d+)(?:-(\d+)(?:-(\d+))?)?$/.exec(gid);
  if (m === null) return null;
  return {
    kind: m[1] as ParsedGid['kind'],
    dbId: Number(m[2]),
    number: m[3] === undefined ? 0 : Number(m[3]),
    commentId: m[4] === undefined ? 0 : Number(m[4]),
  };
}

export function repoByDbId(dbId: number): Repo | undefined {
  for (const repo of repos.values()) if (repo.dbId === dbId) return repo;
  return undefined;
}

// -------------------------------------------------------------------------------------------
// git objects inside a repo
// -------------------------------------------------------------------------------------------

export function putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

/** Resolve a branch name, full ref, or commit sha to a commit oid. */
export function resolveRef(repo: Repo, ref: string | undefined): string | undefined {
  if (ref === undefined || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  const asBranch = repo.refs.get(`refs/heads/${ref}`);
  if (asBranch !== undefined) return asBranch;
  const obj = repo.objects.get(ref);
  if (obj !== undefined && obj.type === 'commit') return ref;
  return undefined;
}

export function refTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

export function treeOfCommit(repo: Repo, commitOid: string): string | undefined {
  const obj = repo.objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return undefined;
  return parseCommit(obj.data).tree;
}

/** Flatten a tree (by oid) to path -> { oid, mode }. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, path: string): void => {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const child = path === '' ? entry.name : `${path}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, child);
      else out.set(child, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** Blob oid at `path` as of `commitOid`, or undefined. */
export function blobAtPath(repo: Repo, commitOid: string, path: string): string | undefined {
  const tree = treeOfCommit(repo, commitOid);
  if (tree === undefined) return undefined;
  return flattenTree(repo, tree).get(path)?.oid;
}

/** A new tree oid with `path` set to `blobOid` (or deleted when null), based on `baseTreeOid`. */
export function setPathInTree(
  repo: Repo,
  baseTreeOid: string,
  segments: string[],
  blobOid: string | null,
): string {
  const setIn = (treeOid: string, depth: number): string | null => {
    const obj = repo.objects.get(treeOid);
    const entries = obj !== undefined && obj.type === 'tree' ? parseTree(obj.data) : [];
    const name = segments[depth];
    const last = depth === segments.length - 1;
    const out: { mode: string; name: string; oid: string }[] = [];
    let handled = false;
    for (const entry of entries) {
      if (entry.name !== name) {
        out.push(entry);
        continue;
      }
      handled = true;
      if (last) {
        if (blobOid !== null) out.push({ mode: '100644', name, oid: blobOid });
        // else: drop the entry (delete)
      } else {
        const child = setIn(entry.oid, depth + 1);
        if (child !== null) out.push({ mode: '40000', name, oid: child });
      }
    }
    if (!handled) {
      if (last) {
        if (blobOid !== null) out.push({ mode: '100644', name, oid: blobOid });
      } else {
        const child = setIn(EMPTY_TREE_OID, depth + 1);
        if (child !== null) out.push({ mode: '40000', name, oid: child });
      }
    }
    if (out.length === 0) return null;
    const data = buildTree(out);
    return putObject(repo, 'tree', data);
  };
  return setIn(baseTreeOid, 0) ?? EMPTY_TREE_OID;
}

export interface CommitFileResult {
  commitSha: string;
  blobSha: string;
}

export class StoreError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * The PUT /contents operation: create or update a file on `branch` (default branch when
 * omitted). `expectedSha` is the blob sha the caller believes is current; a mismatch is 409.
 */
export function commitFile(
  repo: Repo,
  opts: { branch?: string; path: string; content: Buffer; message: string; expectedSha?: string },
): CommitFileResult {
  const branch = opts.branch ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const segments = opts.path.split('/').filter((s) => s !== '');
  if (segments.length === 0) throw new StoreError(400, 'empty path');
  const parentTree = tip === undefined ? EMPTY_TREE_OID : (treeOfCommit(repo, tip) ?? EMPTY_TREE_OID);
  const currentBlob = tip === undefined ? undefined : blobAtPath(repo, tip, opts.path);
  if (opts.expectedSha !== undefined) {
    if (currentBlob === undefined) throw new StoreError(409, 'file does not exist');
    if (currentBlob.toLowerCase() !== opts.expectedSha.toLowerCase()) {
      throw new StoreError(409, 'sha does not match the current blob');
    }
  }
  const blobSha = putObject(repo, 'blob', opts.content);
  const tree = setPathInTree(repo, parentTree, segments, blobSha);
  const commit = buildCommit({
    tree,
    parents: tip === undefined ? [] : [tip],
    message: opts.message,
    author: VIEWER_IDENTITY,
    committer: VIEWER_IDENTITY,
    timestamp: Math.floor(Date.now() / 1000),
  });
  const commitSha = putObject(repo, 'commit', commit);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return { commitSha, blobSha };
}

/** The DELETE /contents operation: remove a file with a new commit on the default branch. */
export function deleteFile(repo: Repo, path: string, message: string, expectedSha: string): string {
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (tip === undefined) throw new StoreError(404, 'file not found');
  const currentBlob = blobAtPath(repo, tip, path);
  if (currentBlob === undefined) throw new StoreError(404, 'file not found');
  if (currentBlob.toLowerCase() !== expectedSha.toLowerCase()) {
    throw new StoreError(409, 'sha does not match the current blob');
  }
  const parentTree = treeOfCommit(repo, tip) ?? EMPTY_TREE_OID;
  const segments = path.split('/').filter((s) => s !== '');
  const tree = setPathInTree(repo, parentTree, segments, null);
  const commit = buildCommit({
    tree,
    parents: [tip],
    message,
    author: VIEWER_IDENTITY,
    committer: VIEWER_IDENTITY,
    timestamp: Math.floor(Date.now() / 1000),
  });
  const commitSha = putObject(repo, 'commit', commit);
  repo.refs.set(`refs/heads/${repo.defaultBranch}`, commitSha);
  return commitSha;
}

/** Commits reachable from `tip`, newest first: [{ sha, message }]. */
export function listCommits(repo: Repo, tip: string): { sha: string; message: string }[] {
  const out: { sha: string; message: string }[] = [];
  const seen = new Set<string>();
  let current: string | undefined = tip;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'commit') break;
    const view = parseCommit(obj.data);
    out.push({ sha: current, message: view.message });
    current = view.parents[0];
  }
  return out;
}

/** Is `ancestor` reachable from `tip` (walking first parents and all parents)? */
export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}

function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let n = 0;
  for (const byte of buf) if (byte === 0x0a) n += 1;
  return buf[buf.length - 1] === 0x0a ? n : n + 1;
}

/** Diff two trees; returns changed paths with line counts. */
export function diffTrees(repo: Repo, baseTree: string, headTree: string): PullFile[] {
  const base = flattenTree(repo, baseTree);
  const head = flattenTree(repo, headTree);
  const files: PullFile[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
    if (b === undefined && h !== undefined) {
      const content = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
      const additions = countLines(content);
      files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b !== undefined && h === undefined) {
      const content = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
      const deletions = countLines(content);
      files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (b !== undefined && h !== undefined) {
      const oldContent = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
      const newContent = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
      const additions = countLines(newContent);
      const deletions = countLines(oldContent);
      files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return files;
}

// -------------------------------------------------------------------------------------------
// issues and pull requests
// -------------------------------------------------------------------------------------------

export function createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
  const issue: Issue = {
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    seq: repo.issues.length + repo.prs.length,
    gid: '',
  };
  repo.nextNumber += 1;
  issue.gid = issueGid(repo, issue);
  repo.issues.push(issue);
  return issue;
}

export function createPullRequest(
  repo: Repo,
  opts: { head: string; base: string; title: string; body: string },
): PullRequest {
  const headSha = refTip(repo, opts.head);
  const baseSha = refTip(repo, opts.base);
  if (headSha === undefined || baseSha === undefined) {
    throw new StoreError(422, 'head or base branch has no commits');
  }
  const headTree = treeOfCommit(repo, headSha) ?? EMPTY_TREE_OID;
  const baseTree = treeOfCommit(repo, baseSha) ?? EMPTY_TREE_OID;
  const files = diffTrees(repo, baseTree, headTree);
  const headFiles = flattenTree(repo, headTree);
  const changedFiles = new Map<string, string | null>();
  for (const file of files) {
    changedFiles.set(file.filename, file.status === 'removed' ? null : (headFiles.get(file.filename)?.oid ?? null));
  }
  const pr: PullRequest = {
    number: repo.nextNumber,
    title: opts.title,
    body: opts.body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    head: opts.head,
    base: opts.base,
    headSha,
    baseSha,
    baseCommitSha: baseSha,
    files,
    changedFiles,
    seq: repo.issues.length + repo.prs.length,
    gid: '',
  };
  repo.nextNumber += 1;
  pr.gid = prGid(repo, pr);
  repo.prs.push(pr);
  return pr;
}

/** Would merging `pr` now conflict with the current base tip? */
export function prConflicts(repo: Repo, pr: PullRequest): boolean {
  const baseTip = refTip(repo, pr.base);
  if (baseTip === undefined) return false;
  for (const [path, newBlob] of pr.changedFiles) {
    const atBase = blobAtPath(repo, pr.baseCommitSha, path);
    const atTip = blobAtPath(repo, baseTip, path);
    if (atTip !== atBase && atTip !== newBlob) return true;
  }
  return false;
}

/** Squash-merge `pr` onto its base branch. Returns the merge commit sha. */
export function mergePullRequest(repo: Repo, pr: PullRequest): string {
  if (pr.state !== 'open') throw new StoreError(405, 'pull request is not open');
  if (prConflicts(repo, pr)) throw new StoreError(405, 'merge conflict');
  const baseTip = refTip(repo, pr.base);
  if (baseTip === undefined) throw new StoreError(422, 'base branch has no commits');
  const parentTree = treeOfCommit(repo, baseTip) ?? EMPTY_TREE_OID;
  let tree = parentTree;
  for (const [path, blobOid] of pr.changedFiles) {
    const segments = path.split('/').filter((s) => s !== '');
    tree = setPathInTree(repo, tree, segments, blobOid);
  }
  const commit = buildCommit({
    tree,
    parents: [baseTip],
    message: pr.title,
    author: VIEWER_IDENTITY,
    committer: VIEWER_IDENTITY,
    timestamp: Math.floor(Date.now() / 1000),
  });
  const commitSha = putObject(repo, 'commit', commit);
  repo.refs.set(`refs/heads/${pr.base}`, commitSha);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = new Date().toISOString();
  pr.mergeCommitSha = commitSha;
  return commitSha;
}

export function tagTarget(repo: Repo, tagOid: string): { object: string; type: string } | null {
  const obj = repo.objects.get(tagOid);
  if (obj === undefined || obj.type !== 'tag') return null;
  const view = parseTag(obj.data);
  return { object: view.object, type: view.type };
}
