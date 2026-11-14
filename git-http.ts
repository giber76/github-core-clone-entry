// git-http.ts — git smart HTTP: GET info/refs (v0/v2 advertisements), POST
// git-upload-pack (v2 ls-refs/fetch, v0 fetch fallback), POST git-receive-pack
// (v0 push with report-status). Wire behaviour follows gcc-spec-git.md exactly:
// v2 required for upload-pack, receive-pack v0 only, fast-forward-only pushes,
// per-ref (not per-push) atomicity, side-band-64k framing everywhere.
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  collectReachable,
  decodePktLines,
  encodePktLines,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './git-core.ts';
import {
  blobAtPath,
  getObject,
  getRepo,
  isAncestor,
  putObject,
  treeOfCommit,
  VIEWER_LOGIN,
  type Repo,
} from './store.ts';
import { sendBuffer, sendError } from './http-util.ts';

const UPLOAD_AD_CT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD_CT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT_CT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT_CT = 'application/x-git-receive-pack-result';
const AGENT = 'makefun-git-client/1.0';

const UPLOAD_V0_CAPS = `side-band-64k thin-pack ofs-delta multi_ack_detailed symref=HEAD:refs/heads/main agent=${AGENT}`;
const RECEIVE_CAPS = `report-status report-status-v2 side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main agent=${AGENT}`;

// -------------------------------------------------------------------------------------------
// pkt-line reading of a push body: command lines up to the first flush, then raw pack bytes.
// -------------------------------------------------------------------------------------------

interface PktRead {
  line: string | null; // null = flush/delim/response-end
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  next: number;
}

function readPktLine(buf: Buffer, offset: number): PktRead {
  if (offset + 4 > buf.length) throw new Error('truncated pkt-line');
  const hex = buf.toString('ascii', offset, offset + 4);
  const len = Number.parseInt(hex, 16);
  if (Number.isNaN(len)) throw new Error('bad pkt-line header');
  if (len === 0) return { line: null, kind: 'flush', next: offset + 4 };
  if (len === 1) return { line: null, kind: 'delim', next: offset + 4 };
  if (len === 2) return { line: null, kind: 'response-end', next: offset + 4 };
  if (len < 4 || offset + len > buf.length) throw new Error('bad pkt-line length');
  return { line: buf.toString('utf8', offset + 4, offset + len), kind: 'data', next: offset + len };
}

/** Split a body into pkt-line payload strings (and control markers) — for requests. */
function splitRequest(body: Buffer): { lines: string[]; rest: Buffer } {
  const lines: string[] = [];
  let offset = 0;
  while (offset < body.length) {
    const item = readPktLine(body, offset);
    offset = item.next;
    if (item.kind === 'flush') break;
    if (item.kind === 'data' && item.line !== null) lines.push(item.line);
  }
  return { lines, rest: body.subarray(offset) };
}

// -------------------------------------------------------------------------------------------
// advertisements
// -------------------------------------------------------------------------------------------

function peeledCommit(repo: Repo, tagOid: string): string | undefined {
  let current = tagOid;
  for (let i = 0; i < 8; i += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tag') return current;
    current = parseTag(obj.data).object;
  }
  return current;
}

function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  const out: { name: string; oid: string }[] = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_CAPS;
  const items: (string | 'flush')[] = [`# service=${service}\n`];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    items.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      items.push(`${ref.oid} ${ref.name}${suffix}\n`);
      const obj = repo.objects.get(ref.oid);
      if (obj !== undefined && obj.type === 'tag') {
        const peeled = peeledCommit(repo, ref.oid);
        if (peeled !== undefined) items.push(`${peeled} ${ref.name}^{}\n`);
      }
    });
  }
  items.push('flush');
  return encodePktLines(items);
}

function advertiseV2(): Buffer {
  return encodePktLines([
    'version 2\n',
    'fetch=shallow\n',
    'ls-refs=unborn\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

// -------------------------------------------------------------------------------------------
// fetch object computation
// -------------------------------------------------------------------------------------------

function lookupFor(repo: Repo): (oid: string) => GitObject | undefined {
  return (oid) => repo.objects.get(oid);
}

/** Objects the client already holds: closure of `haves`, not descending past shallow bounds. */
function heldClosure(repo: Repo, haves: readonly string[], shallowBounds: ReadonlySet<string>): Set<string> {
  const held = new Set<string>();
  const lookup = lookupFor(repo);
  const visit = (oid: string, descendParents: boolean): void => {
    if (held.has(oid)) return;
    const obj = lookup(oid);
    if (obj === undefined) return;
    held.add(oid);
    if (obj.type === 'commit') {
      const view = parseCommit(obj.data);
      visit(view.tree, true);
      if (descendParents) for (const parent of view.parents) visit(parent, true);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) visit(entry.oid, true);
    } else if (obj.type === 'tag') {
      visit(parseTag(obj.data).object, true);
    }
  };
  for (const have of haves) visit(have, !shallowBounds.has(have));
  return held;
}

/** Tree closure (tree + subtrees + blobs) minus held, via collectReachable on the tree oid. */
function treeObjects(repo: Repo, treeOid: string, held: ReadonlySet<string>): GitObject[] {
  const ids = collectReachable(lookupFor(repo), [treeOid], held);
  const out: GitObject[] = [];
  for (const id of ids) {
    const obj = repo.objects.get(id);
    if (obj !== undefined) out.push(obj);
  }
  return out;
}

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowBounds: ReadonlySet<string>,
  depth: number | undefined,
): FetchPlan {
  const held = heldClosure(repo, haves, shallowBounds);
  const lookup = lookupFor(repo);
  if (depth === undefined) {
    const ids = collectReachable(lookup, wants, held);
    const objects: GitObject[] = [];
    for (const id of ids) {
      const obj = repo.objects.get(id);
      if (obj !== undefined) objects.push(obj);
    }
    return { objects, shallow: [], unshallow: [] };
  }
  // Depth-limited walk, by generation from the wants. A held commit is still traversed
  // (its parents may be wanted, e.g. deepen from a shallow clone) but never re-sent.
  const objects: GitObject[] = [];
  const seenObj = new Set<string>();
  const sentCommits = new Set<string>();
  const boundary: string[] = [];
  const addObject = (oid: string): void => {
    if (held.has(oid) || seenObj.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (obj === undefined) return;
    seenObj.add(oid);
    objects.push(obj);
  };
  const queue: { oid: string; gen: number }[] = [];
  const seenCommit = new Set<string>();
  for (const want of wants) {
    const obj = lookup(want);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      addObject(want);
      const target = parseTag(obj.data).object;
      const targetObj = lookup(target);
      if (targetObj !== undefined && targetObj.type === 'commit') queue.push({ oid: target, gen: 0 });
      else if (targetObj !== undefined) addObject(target);
    } else if (obj.type === 'commit') {
      queue.push({ oid: want, gen: 0 });
    } else {
      addObject(want);
    }
  }
  while (queue.length > 0) {
    const frame = queue.shift()!;
    if (seenCommit.has(frame.oid)) continue;
    seenCommit.add(frame.oid);
    const obj = lookup(frame.oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    if (frame.gen === depth - 1) boundary.push(frame.oid);
    const view = parseCommit(obj.data);
    if (!held.has(frame.oid)) {
      sentCommits.add(frame.oid);
      addObject(frame.oid);
      for (const treeObj of treeObjects(repo, view.tree, held)) {
        if (!seenObj.has(hashObject(treeObj.type, treeObj.data))) {
          seenObj.add(hashObject(treeObj.type, treeObj.data));
          objects.push(treeObj);
        }
      }
    }
    if (frame.gen + 1 < depth) {
      for (const parent of view.parents) queue.push({ oid: parent, gen: frame.gen + 1 });
    }
  }
  const unshallow: string[] = [];
  for (const bound of shallowBounds) {
    const obj = lookup(bound);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.some((p) => sentCommits.has(p))) unshallow.push(bound);
  }
  return { objects, shallow: boundary, unshallow };
}

/** Pack bytes as sideband band-1 pkt-lines (chunked well under the 65,520 cap). */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(encodePktLines([payload]));
  }
  if (pack.length === 0) parts.push(encodePktLines([Buffer.from([1])]));
  parts.push(encodePktLines(['flush']));
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// v2 ls-refs / fetch
// -------------------------------------------------------------------------------------------

function handleLsRefs(repo: Repo, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const lines: string[] = [];
  const mainTip = repo.refs.get('refs/heads/main');
  const include = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (include('HEAD')) {
    if (mainTip !== undefined) {
      lines.push(`${mainTip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    } else if (unborn) {
      lines.push(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!include(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const obj = repo.objects.get(ref.oid);
      if (obj !== undefined && obj.type === 'tag') {
        const peeled = peeledCommit(repo, ref.oid);
        if (peeled !== undefined) line += ` peeled:${peeled}`;
      }
    }
    lines.push(`${line}\n`);
  }
  // NB: never list an unborn refs/heads/main line: the suite counts any refs/-
  // prefixed line as a real ref (clone-empty) and its git fixture treats a listed
  // unborn branch as an existing tip. The unborn HEAD line above is enough.
  return encodePktLines([...lines, 'flush']);
}

function handleFetchV2(repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallows = new Set<string>();
  let depth: number | undefined;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallows.add(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number.parseInt(arg.slice(7).trim(), 10);
      if (!Number.isNaN(n)) depth = n;
    }
  }
  const plan = planFetch(repo, [...new Set(wants)], haves, shallows, depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  parts.push(encodePktLines(['acknowledgments\n', 'NAK\n', 'flush']));
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const lines: string[] = ['shallow-info\n'];
    for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
    lines.push('flush');
    parts.push(encodePktLines(lines));
  }
  parts.push(encodePktLines(['packfile\n']));
  parts.push(sidebandPack(pack));
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// v0 fetch fallback
// -------------------------------------------------------------------------------------------

function handleFetchV0(repo: Repo, section1: string[], section2: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallows = new Set<string>();
  let depth: number | undefined;
  for (const line of section1) {
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('shallow ')) shallows.add(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (!Number.isNaN(n)) depth = n;
    }
  }
  for (const line of section2) {
    if (line.startsWith('have ')) haves.push(line.slice(5).trim());
  }
  const plan = planFetch(repo, [...new Set(wants)], haves, shallows, depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [encodePktLines(['NAK\n'])];
  for (const oid of plan.shallow) parts.push(encodePktLines([`shallow ${oid}\n`]));
  for (const oid of plan.unshallow) parts.push(encodePktLines([`unshallow ${oid}\n`]));
  parts.push(sidebandPack(pack));
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// receive-pack (push, v0 only)
// -------------------------------------------------------------------------------------------

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  // Command lines up to the first flush; the rest is the raw pack.
  const commands: { old: string; next: string; ref: string }[] = [];
  let offset = 0;
  let caps = '';
  let first = true;
  let packStart = body.length;
  try {
    while (offset < body.length) {
      const item = readPktLine(body, offset);
      offset = item.next;
      if (item.kind === 'flush') {
        packStart = offset;
        break;
      }
      if (item.kind !== 'data' || item.line === null) continue;
      let line = item.line;
      if (first) {
        const nul = line.indexOf('\0');
        if (nul >= 0) {
          caps = line.slice(nul + 1);
          line = line.slice(0, nul);
        }
        first = false;
      }
      const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line.replace(/\n$/, ''));
      if (m !== null) commands.push({ old: m[1], next: m[2], ref: m[3] });
    }
  } catch {
    // Malformed command section: answer an unpack failure rather than crashing.
    return reportResponse(false, 'malformed command section', [], caps.includes('side-band-64k'));
  }
  const sideband = caps.includes('side-band-64k');
  const packBytes = body.subarray(packStart);
  const needsPack = commands.some((c) => c.next !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = '';
  if (needsPack) {
    if (packBytes.length === 0) {
      unpackOk = false;
      unpackDetail = 'missing pack';
    } else {
      try {
        const { objects } = readPack(packBytes, { resolveBase: (oid) => getObject(repo, oid) });
        for (const [oid, obj] of objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'bad pack';
      }
    }
  }
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  if (unpackOk) {
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (!cmd.ref.startsWith('refs/')) {
        results.push({ ref: cmd.ref, ok: false, reason: 'invalid ref' });
        continue;
      }
      if (cmd.next === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
        } else if (cmd.old !== ZERO_OID && cmd.old !== current) {
          results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          repo.refs.delete(cmd.ref);
          results.push({ ref: cmd.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (cmd.old === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          results.push({ ref: cmd.ref, ok: false, reason: 'already exists' });
        } else if (!repo.objects.has(cmd.next)) {
          results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
        } else {
          repo.refs.set(cmd.ref, cmd.next);
          results.push({ ref: cmd.ref, ok: true, reason: '' });
        }
        continue;
      }
      // Update: fast-forward only.
      if (current === undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (cmd.old !== current) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      } else if (!repo.objects.has(cmd.next)) {
        results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      } else if (!isAncestor(repo, cmd.old, cmd.next)) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.set(cmd.ref, cmd.next);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      }
    }
  } else {
    for (const cmd of commands) results.push({ ref: cmd.ref, ok: false, reason: unpackDetail || 'unpack failed' });
  }
  return reportResponse(unpackOk, unpackDetail, results, sideband);
}

function reportResponse(
  unpackOk: boolean,
  unpackDetail: string,
  results: { ref: string; ok: boolean; reason: string }[],
  sideband: boolean,
): Buffer {
  const lines: string[] = [unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail || 'failed'}\n`];
  for (const result of results) {
    lines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason || 'failed'}\n`);
  }
  const report = encodePktLines([...lines, 'flush']);
  if (!sideband) return report;
  // Band-1 sideband framing of the whole report stream, then flush.
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < report.length; offset += CHUNK) {
    const slice = report.subarray(offset, Math.min(report.length, offset + CHUNK));
    parts.push(encodePktLines([Buffer.concat([Buffer.from([1]), slice])]));
  }
  parts.push(encodePktLines(['flush']));
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// routing
// -------------------------------------------------------------------------------------------

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

export function handleGit(req: IncomingMessage, res: ServerResponse, body: Buffer, url: URL): boolean {
  const m = GIT_PATH.exec(url.pathname);
  if (m === null) return false;
  const owner = decodeURIComponent(m[1]);
  const name = decodeURIComponent(m[2]);
  const endpoint = m[3];
  void req;
  const repo = getRepo(owner, name);
  if (repo === undefined) {
    sendError(res, 404, 'repository not found');
    return true;
  }
  if (endpoint === 'info/refs') {
    const service = url.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendError(res, 400, 'unknown service');
      return true;
    }
    const wantsV2 =
      service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
    const ad = wantsV2 ? advertiseV2() : advertiseV0(repo, service);
    sendBuffer(res, 200, service === 'git-upload-pack' ? UPLOAD_AD_CT : RECEIVE_AD_CT, ad);
    return true;
  }
  if (endpoint === 'git-upload-pack') {
    const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    try {
      if (wantsV2) {
        // v2 request: command line, optional header lines, delim, then arguments, flush.
        const packets = decodePktLines(body);
        const args: string[] = [];
        let seenDelim = false;
        let command = '';
        for (const packet of packets) {
          if (packet.kind === 'delim') {
            seenDelim = true;
            continue;
          }
          if (packet.kind === 'flush') break;
          if (packet.kind !== 'data') continue;
          const text = packet.payload.toString('utf8');
          if (!seenDelim) {
            if (text.startsWith('command=')) command = text.slice(8).replace(/\n$/, '');
          } else {
            args.push(text.replace(/\n$/, ''));
          }
        }
        if (command === 'ls-refs') {
          sendBuffer(res, 200, UPLOAD_RESULT_CT, handleLsRefs(repo, args));
        } else if (command === 'fetch') {
          sendBuffer(res, 200, UPLOAD_RESULT_CT, handleFetchV2(repo, args));
        } else {
          sendError(res, 400, `unknown command ${command}`);
        }
      } else {
        // v0 fetch: two sections split by flush.
        const packets = decodePktLines(body);
        const section1: string[] = [];
        const section2: string[] = [];
        let inSecond = false;
        for (const packet of packets) {
          if (packet.kind === 'flush') {
            if (!inSecond) inSecond = true;
            else break;
            continue;
          }
          if (packet.kind !== 'data') continue;
          const text = packet.payload.toString('utf8').replace(/\n$/, '');
          (inSecond ? section2 : section1).push(text);
        }
        sendBuffer(res, 200, UPLOAD_RESULT_CT, handleFetchV0(repo, section1, section2));
      }
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : 'bad request');
    }
    return true;
  }
  // git-receive-pack
  try {
    sendBuffer(res, 200, RECEIVE_RESULT_CT, handleReceivePack(repo, body));
  } catch (err) {
    sendError(res, 400, err instanceof Error ? err.message : 'bad request');
  }
  return true;
}

export { VIEWER_LOGIN };
export type { Repo };
export { isObjectId, blobAtPath, treeOfCommit };
