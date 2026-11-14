// git-core.ts — the git object model, packfiles and pkt-lines, in plain Node.
// No git binary, no dependency: everything the forge stores and serves is built here
// from node:crypto (SHA-1) and node:zlib (deflate/inflate).
//
// Object model
//   Every object is "<type> <byte length>\0<body>", hashed with SHA-1. The four types are
//   commit, tree, blob and tag. A commit names its tree, its parents, an author and a committer
//   line and a message. A tree is a run of "<mode> <name>\0<20 raw oid bytes>" entries, sorted
//   by name (directories sort as if their name had a trailing slash). A tag names its object,
//   its type, its tag name and a tagger line.
//
// Packfiles
//   A pack is "PACK", version 2, a 4-byte object count, then each object (a type+size varint
//   header, then zlib-deflated bytes), then the SHA-1 trailer over everything before it. This
//   forge WRITES plain objects only (no deltas): the packs are small and the client's reader
//   resolves them without delta work. It READS plain objects and both delta kinds (OFS_DELTA,
//   REF_DELTA), because a push could carry either and a thin pack's bases may be objects the
//   forge already holds.
//
// pkt-lines
//   A pkt-line is 4 hex digits of (payload length + 4) then the payload. 0000 is a flush, 0001 a
//   delim, 0002 a response-end. Sideband band 1 is pack data, band 2 is progress text, band 3 is
//   an error.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

const OBJECT_TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_OBJECT_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** True when the string is 40 lowercase hex digits. */
export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** The SHA-1 of "<type> <length>\0<data>", exactly as git computes it. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const header = Buffer.from(`${type} ${data.byteLength}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** The stored bytes of one object: the "<type> <length>\0" header plus its body. */
export function objectBytes(type: GitObjectType, data: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${data.byteLength}\0`, 'utf8'), Buffer.from(data)]);
}

// ---------------------------------------------------------------------------------------------
// commits, trees, tags
// ---------------------------------------------------------------------------------------------

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** Parse a commit's body into its tree, parents, author/committer lines and message. */
export function parseCommit(data: Uint8Array): CommitView {
  const text = Buffer.from(data).toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface BuildCommitFields {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
  readonly author: string;
  readonly committer: string;
  readonly timestamp?: number;
  readonly timezone?: string;
}

/** Build a commit's body. The author/committer are full "Name <email>" identities. */
export function buildCommit(fields: BuildCommitFields): Buffer {
  const timestamp = fields.timestamp ?? 1700000000;
  const timezone = fields.timezone ?? '+0000';
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${timestamp} ${timezone}`);
  lines.push(`committer ${fields.committer} ${timestamp} ${timezone}`);
  lines.push('', fields.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree's body into its entries, in stored order. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buf = Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const space = buf.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = buf.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > buf.length) break;
    const mode = buf.toString('utf8', offset, space);
    const name = buf.toString('utf8', space + 1, nul);
    const oid = buf.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** A tree entry sorts by name, directories as if their name had a trailing slash. */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const aName = a.mode === '40000' ? `${a.name}/` : a.name;
  const bName = b.mode === '40000' ? `${b.name}/` : b.name;
  return aName < bName ? -1 : aName > bName ? 1 : 0;
}

/** Build a tree's body from entries, sorted the way git stores them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse an annotated tag's body. */
export function parseTag(data: Uint8Array): TagView {
  const text = Buffer.from(data).toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------------------------

/** The largest pkt-line including its 4-byte length (git's LARGE_PACKET_MAX). */
export const PKT_LINE_MAX = 65520;

function pktLine(payload: Uint8Array): Buffer {
  if (payload.length + 4 > PKT_LINE_MAX) throw new Error(`pkt-line payload is ${payload.length} bytes, over the limit`);
  const header = Buffer.allocUnsafe(4);
  header.write((payload.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, Buffer.from(payload)]);
}

export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktLineResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

/** Encode a sequence; 'flush' | 'delim' | 'response-end' are the control packets. */
export function encodePktLines(items: ReadonlyArray<string | Uint8Array | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktLineFlush());
    else if (item === 'delim') parts.push(pktLineDelim());
    else if (item === 'response-end') parts.push(pktLineResponseEnd());
    else parts.push(pktLine(typeof item === 'string' ? Buffer.from(item, 'utf8') : item));
  }
  return Buffer.concat(parts);
}

export type GitPacket =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

/** Decode a whole buffer of pkt-lines. Throws on a malformed header or a truncated packet. */
export function decodePktLines(bytes: Uint8Array): GitPacket[] {
  const buf = Buffer.from(bytes);
  const out: GitPacket[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line header');
    const header = buf.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      out.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      out.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      out.push({ kind: 'response-end' });
      offset += 4;
    } else if (length < 4 || length > PKT_LINE_MAX) {
      throw new Error(`invalid pkt-line length ${length}`);
    } else {
      if (offset + length > buf.length) throw new Error('truncated pkt-line');
      out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return out;
}

/** Split decoded pkt-lines into their text lines (each payload, trailing newline stripped). */
export function packetLines(packets: readonly GitPacket[]): string[] {
  const out: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    out.push(line.endsWith('\n') ? line.slice(0, -1) : line);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// deltas
// ---------------------------------------------------------------------------------------------

/** Read a delta's variable-length size prefix. Returns the size and the offset after it. */
function readDeltaSize(buf: Buffer, offset: number): { size: number; next: number } {
  let size = 0;
  let shift = 0;
  let at = offset;
  for (;;) {
    const byte = buf[at];
    at += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { size, next: at };
}

/**
 * Apply a delta to its base, producing the target bytes. The delta is a source size, a target
 * size, then a run of copy (from the base) and insert (literal) instructions.
 */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const buf = Buffer.from(delta);
  const source = readDeltaSize(buf, 0);
  if (source.size !== base.byteLength) throw new Error(`delta base size ${source.size} does not match ${base.byteLength}`);
  const target = readDeltaSize(buf, source.next);
  const out = Buffer.allocUnsafe(target.size);
  let outAt = 0;
  let at = target.next;
  while (at < buf.length) {
    const op = buf[at];
    at += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          offset |= buf[at] << (bit * 8);
          at += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          size |= buf[at] << (bit * 8);
          at += 1;
        }
      }
      if (size === 0) size = 0x10000;
      Buffer.from(base).copy(out, outAt, offset, offset + size);
      outAt += size;
    } else if (op !== 0) {
      buf.copy(out, outAt, at, at + op);
      outAt += op;
      at += op;
    } else {
      throw new Error('delta has a zero opcode');
    }
  }
  if (outAt !== target.size) throw new Error(`delta produced ${outAt} bytes, expected ${target.size}`);
  return out;
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

/** The SHA-1 trailer of a pack's bytes (everything before the last 20 bytes). */
export function packChecksum(pack: Uint8Array): string {
  return createHash('sha1').update(Buffer.from(pack)).digest('hex');
}

/** Write a pack of plain objects (no deltas): header, one zlib-deflated object each, trailer. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [Buffer.from('PACK'), Buffer.alloc(8)];
  parts[1].writeUInt32BE(2, 0);
  parts[1].writeUInt32BE(list.length, 4);
  for (const object of list) {
    const typeCode = OBJECT_TYPE_CODE[object.type];
    const size = object.data.byteLength;
    // Object header: type in bits 4-6, size in bits 0-3 then 7 bits a byte, little-endian, MSB set
    // on every byte but the last.
    const header: number[] = [];
    let remaining = size;
    let first = true;
    for (;;) {
      let byte = 0;
      if (first) {
        byte = (typeCode << 4) | (remaining & 0x0f);
        remaining >>= 4;
        first = false;
      } else {
        byte = remaining & 0x7f;
        remaining >>= 7;
      }
      if (remaining > 0) byte |= 0x80;
      header.push(byte);
      if (remaining === 0) break;
    }
    parts.push(Buffer.from(header));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

export interface PackReadResult {
  readonly objects: Map<string, GitObject>;
  readonly deltaCount: number;
}

/** Read a packfile: inflate every object, resolve deltas (bases from the pack or `resolveBase`). */
export function readPack(
  pack: Uint8Array,
  options: { resolveBase?: (oid: string) => GitObject | undefined } = {},
): PackReadResult {
  const buf = Buffer.from(pack);
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const expected = packChecksum(buf.subarray(0, buf.length - 20));
  const actual = buf.subarray(buf.length - 20).toString('hex');
  if (expected !== actual) throw new Error(`pack trailer ${actual} does not match its bytes ${expected}`);

  interface RawEntry {
    readonly offset: number;
    readonly type: GitObjectType | 'ofs-delta' | 'ref-delta';
    readonly size: number;
    readonly data: Buffer;
    readonly baseOffset?: number;
    readonly baseOid?: string;
  }
  const raw: RawEntry[] = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    const first = buf[offset];
    offset += 1;
    const typeCode = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    while (first & 0x80) {
      const byte = buf[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    if (typeCode === 6) {
      // OFS_DELTA: the base is a negative offset from this entry's start.
      let byte = buf[offset];
      offset += 1;
      let baseOffset = byte & 0x7f;
      while (byte & 0x80) {
        byte = buf[offset];
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      const inflated = inflateAt(buf, offset);
      raw.push({ offset: start, type: 'ofs-delta', size, data: inflated.data, baseOffset: start - baseOffset });
      offset = inflated.next;
    } else if (typeCode === 7) {
      // REF_DELTA: the base is named by object id.
      const baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateAt(buf, offset);
      raw.push({ offset: start, type: 'ref-delta', size, data: inflated.data, baseOid });
      offset = inflated.next;
    } else {
      const type = CODE_OBJECT_TYPE[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const inflated = inflateAt(buf, offset);
      raw.push({ offset: start, type, size, data: inflated.data });
      offset = inflated.next;
    }
  }

  const byOffset = new Map<number, RawEntry>();
  for (const entry of raw) byOffset.set(entry.offset, entry);
  const objects = new Map<string, GitObject>();
  let deltaCount = 0;

  const resolve = (entry: RawEntry, seen: Set<number>): GitObject => {
    if (entry.type === 'ofs-delta' || entry.type === 'ref-delta') {
      deltaCount += 1;
      let base: GitObject | undefined;
      if (entry.type === 'ofs-delta') {
        if (entry.baseOffset === undefined) throw new Error('ofs-delta without a base offset');
        if (seen.has(entry.baseOffset)) throw new Error('delta cycle');
        const baseEntry = byOffset.get(entry.baseOffset);
        if (baseEntry === undefined) throw new Error('ofs-delta base is outside the pack');
        base = resolve(baseEntry, new Set([...seen, entry.offset]));
      } else {
        if (entry.baseOid === undefined) throw new Error('ref-delta without a base id');
        base = objects.get(entry.baseOid) ?? options.resolveBase?.(entry.baseOid);
        if (base === undefined) throw new Error(`ref-delta base ${entry.baseOid} is not in the pack`);
      }
      const data = applyDelta(base.data, entry.data);
      return { type: base.type, data };
    }
    return { type: entry.type as GitObjectType, data: entry.data };
  };

  for (const entry of raw) {
    const object = resolve(entry, new Set());
    objects.set(hashObject(object.type, object.data), object);
  }
  return { objects, deltaCount };
}

/** Inflate one zlib stream starting at `offset`; returns the bytes and the offset after it. */
export function inflateAt(buffer: Uint8Array, offset: number): { data: Buffer; next: number } {
  // inflateSync ignores bytes after the first complete stream, so the predicate "this prefix
  // inflates" is monotone in the prefix length: binary-search the smallest prefix that does.
  let low = offset;
  let high = buffer.length;
  if (high - low < 1) throw new Error('unterminated zlib stream in pack');
  let end = -1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    try {
      inflateSync(buffer.subarray(offset, mid));
      end = mid;
      high = mid - 1;
    } catch {
      low = mid + 1;
    }
  }
  if (end < 0) throw new Error('unterminated zlib stream in pack');
  return { data: inflateSync(buffer.subarray(offset, end)), next: end };
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

/**
 * Walk from `tips` through commits, their trees and blobs, collecting every object id reached.
 * `stopAt` names objects already held: the walk does not pass through them (their trees are not
 * re-listed either). Returns the reached ids in walk order.
 */
export function collectReachable(
  lookup: (oid: string) => GitObject | undefined,
  tips: readonly string[],
  stopAt: ReadonlySet<string> = new Set(),
): string[] {
  const reached: string[] = [];
  const seen = new Set<string>();
  const visitObject = (oid: string): void => {
    if (seen.has(oid) || stopAt.has(oid)) return;
    const object = lookup(oid);
    if (object === undefined) return;
    seen.add(oid);
    reached.push(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      visitObject(commit.tree);
      for (const parent of commit.parents) visitObject(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) visitObject(entry.oid);
    } else if (object.type === 'tag') {
      visitObject(parseTag(object.data).object);
    }
  };
  for (const tip of tips) visitObject(tip);
  return reached;
}

/**
 * The objects a fetch of `wants` must send, given the client's `haves`: everything reachable
 * from the wants that is not reachable from the haves. `depth` limits the commit walk: with a
 * depth, only commits within `depth` generations of a want are sent, and the boundary commits
 * are returned as the shallow set.
 */
export function objectsForFetch(
  lookup: (oid: string) => GitObject | undefined,
  wants: readonly string[],
  haves: readonly string[],
  depth?: number,
): { objects: GitObject[]; shallow: string[] } {
  const haveReachable = new Set(collectReachable(lookup, haves));
  const objects: GitObject[] = [];
  const shallow: string[] = [];
  const seen = new Set<string>();
  // Walk commits by generation from the wants, so a depth limit cuts whole generations.
  interface Frame {
    readonly oid: string;
    readonly generation: number;
  }
  const queue: Frame[] = wants.map((oid) => ({ oid, generation: 0 }));
  const commitSeen = new Set<string>();
  while (queue.length > 0) {
    const frame = queue.shift()!;
    if (commitSeen.has(frame.oid) || haveReachable.has(frame.oid)) continue;
    const object = lookup(frame.oid);
    if (object === undefined || object.type !== 'commit') continue;
    commitSeen.add(frame.oid);
    if (depth !== undefined && frame.generation >= depth) {
      shallow.push(frame.oid);
      continue;
    }
    const commit = parseCommit(object.data);
    // The commit, its tree and its blobs, in one pass.
    const ids = collectReachable(lookup, [frame.oid], haveReachable);
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const obj = lookup(id);
      if (obj !== undefined) objects.push(obj);
    }
    for (const parent of commit.parents) {
      queue.push({ oid: parent, generation: frame.generation + 1 });
    }
  }
  return { objects, shallow };
}
