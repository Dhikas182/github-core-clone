// makefun-forge — a GitHub-compatible git forge in one Node 22 process.
//
// Serves, from a single in-memory store and the Node standard library only:
//   1. git smart HTTP (upload-pack v2, upload-pack v0, receive-pack v0)
//   2. REST v3 under /api/v3 (repos, issues, pull requests, contents)
//   3. GraphQL at /api/graphql (the documents gh and github-mcp-server send)
//   4. MCP at /mcp (JSON-RPC 2.0 Streamable HTTP, 2026-07-28 + legacy handshake)
//
// Lifecycle (per the competition rules): bind an ephemeral port, POST {"port": n}
// to $MAKEFUN_ENV_URL/register, long-poll GET $MAKEFUN_ENV_URL/done until
// {"done": true}, then exit 0.
//
// Determinism: the store keeps no clock, no randomness. Every timestamp is a
// fixed base epoch plus a monotonic creation-sequence counter, so two runs on
// the same instance leave the same state export byte for byte.
//
// Written from the competition spec (RULES.txt and the practice suite's
// documented wire contract). No git binary, no dependencies, no outside service.

import http from 'node:http';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';

// ---------------------------------------------------------------- constants

const VIEWER_LOGIN = 'adaiversen'; // the scenario's viewer (fixed scenario seed)
const VIEWER_ID = 1000;
const VIEWER_NAME = 'ada iversen';
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const ZERO_OID = '0000000000000000000000000000000000000000';
const BASE_EPOCH = 1767225600; // 2026-01-01T00:00:00Z; timestamps are BASE + seq
const DEFAULT_BRANCH = 'main';
const SERVER_NAME = 'makefun-forge';
const SERVER_VERSION = '1.0.0';
const AGENT = 'makefun-forge/1.0.0';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

// ---------------------------------------------------------------- small utils

function sha1Hex(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

function isOid(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
}

function b64encode(buf: Buffer): string {
  return buf.toString('base64');
}

function b64decode(s: string): Buffer {
  return Buffer.from(s, 'base64');
}

function globalId(kind: string, key: string): string {
  return b64encode(Buffer.from(`${kind}:${key}`, 'utf8'));
}

function decodeGlobalId(id: unknown): { kind: string; key: string } | null {
  if (typeof id !== 'string' || id === '') return null;
  try {
    const text = b64decode(id).toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 1) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function isoFromSeq(seq: number): string {
  return new Date((BASE_EPOCH + seq) * 1000).toISOString();
}

function jsonStringify(value: unknown): string {
  return JSON.stringify(value);
}

// A monotonic counter for request ids and for deterministic timestamps.
let seqCounter = 0;
function nextSeq(): number {
  seqCounter += 1;
  return seqCounter;
}
let requestCounter = 0;

// ---------------------------------------------------------------- git objects

type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

interface GitObject {
  type: ObjType;
  data: Buffer;
}

function objectId(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

function storeObject(objects: Map<string, GitObject>, type: ObjType, data: Buffer): string {
  const oid = objectId(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    const nul = data.indexOf(0, space);
    if (space < 0 || nul < 0) break;
    const mode = data.subarray(i, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  if (an < bn) return -1;
  if (an > bn) return 1;
  return 0;
}

function encodeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
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

function encodeCommit(tree: string, parents: string[], author: string, committer: string, message: string): Buffer {
  const lines: string[] = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${author}`, `committer ${committer}`, '', message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

function gitIdentity(epochSec: number): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${epochSec} +0000`;
}

/** Parse "Name <email> epoch tz" from a commit header line. */
function parseIdentity(line: string): { name: string; email: string; date?: string } {
  const m = line.match(/^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/);
  if (!m) return { name: VIEWER_NAME, email: VIEWER_EMAIL };
  return { name: m[1] as string, email: m[2] as string, date: new Date(parseInt(m[3] as string, 10) * 1000).toISOString() };
}

/** Insert or replace `path` in the tree rooted at `rootOid` ('' for empty). */
function treeWithFile(objects: Map<string, GitObject>, rootOid: string, path: string, blobOid: string | null): string {
  const parts = path.split('/').filter((p) => p !== '');
  if (parts.length === 0) return rootOid;
  return writeTreeLevel(objects, rootOid, parts, 0, blobOid);
}

function writeTreeLevel(objects: Map<string, GitObject>, treeOid: string, parts: string[], depth: number, blobOid: string | null): string {
  const entries = new Map<string, TreeEntry>();
  if (treeOid !== '') {
    const obj = objects.get(treeOid);
    if (obj && obj.type === 'tree') {
      for (const e of parseTree(obj.data)) entries.set(e.name, e);
    }
  }
  const name = parts[depth] as string;
  if (depth === parts.length - 1) {
    if (blobOid === null) entries.delete(name);
    else entries.set(name, { mode: '100644', name, oid: blobOid });
  } else {
    const child = entries.get(name);
    const childOid = child && child.mode === '40000' ? child.oid : '';
    const next = writeTreeLevel(objects, childOid, parts, depth + 1, blobOid);
    if (next === '') entries.delete(name);
    else entries.set(name, { mode: '40000', name, oid: next });
  }
  if (entries.size === 0) return '';
  const data = encodeTree([...entries.values()]);
  return storeObject(objects, 'tree', data);
}

/** Flatten a tree to path -> {oid, mode}, recursively. */
function flattenTree(objects: Map<string, GitObject>, treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
  if (treeOid === '') return;
  const obj = objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return;
  for (const e of parseTree(obj.data)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') flattenTree(objects, e.oid, path, out);
    else out.set(path, { oid: e.oid, mode: e.mode });
  }
}

/** All objects reachable from `roots`, walking commits -> trees -> blobs. */
function collectReachable(objects: Map<string, GitObject>, roots: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      if (c.tree !== '') stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
      if (m) stack.push(m[1] as string);
    }
  }
  return seen;
}

/** Commit generations from `roots`: map oid -> generation (0 = the roots). Tag objects peel to their target at the same generation. When `maxDepth` is given, parents beyond it are not visited. */
function commitGenerations(objects: Map<string, GitObject>, roots: string[], maxDepth?: number): Map<string, number> {
  const gen = new Map<string, number>();
  const queue: Array<{ oid: string; g: number }> = roots.map((oid) => ({ oid, g: 0 }));
  while (queue.length > 0) {
    const { oid, g } = queue.shift() as { oid: string; g: number };
    const prev = gen.get(oid);
    if (prev !== undefined && prev <= g) continue;
    const obj = objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      gen.set(oid, g);
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
      if (m) queue.push({ oid: m[1] as string, g });
      continue;
    }
    if (obj.type !== 'commit') continue;
    gen.set(oid, g);
    if (maxDepth !== undefined && g + 1 >= maxDepth) continue;
    for (const p of parseCommit(obj.data).parents) queue.push({ oid: p, g: g + 1 });
  }
  return gen;
}

/** Is `ancestor` reachable from `tip` (walking parents)? */
function isAncestor(objects: Map<string, GitObject>, tip: string, ancestor: string): boolean {
  if (tip === ancestor) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}

/** Merge-base of two commits: the common ancestor with the smallest max generation. */
function mergeBase(objects: Map<string, GitObject>, a: string, b: string): string | null {
  const ga = commitGenerations(objects, [a]);
  const gb = commitGenerations(objects, [b]);
  let best: string | null = null;
  let bestScore = Infinity;
  for (const [oid, da] of ga) {
    const db = gb.get(oid);
    if (db === undefined) continue;
    const score = Math.max(da, db);
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

// ---------------------------------------------------------------- pkt-lines

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

interface Pkt {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.subarray(i, i + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error(`bad pkt-line length at ${i}`);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      i += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      i += 4;
    } else if (len === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      i += 4;
    } else {
      if (i + len > buf.length) throw new Error('truncated pkt-line');
      out.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
      i += len;
    }
  }
  if (i !== buf.length) throw new Error('trailing bytes after pkt-lines');
  return out;
}

// ---------------------------------------------------------------- pack files

const PACK_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_IDS: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function readVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = (buf[offset] as number) & 0x0f;
  let shift = 4;
  let i = offset + 1;
  while ((buf[i - 1] as number) & 0x80) {
    value |= ((buf[i] as number) & 0x7f) << shift;
    shift += 7;
    i += 1;
  }
  return { value, next: i };
}

/** Apply a git binary delta to `base`, returning the result. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readDeltaVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = delta[pos] as number;
      pos += 1;
      value |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return value;
  };
  const srcSize = readDeltaVarint();
  const dstSize = readDeltaVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const chunks: Buffer[] = [];
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset = delta[pos] as number; pos += 1; }
      if (op & 0x02) { offset |= (delta[pos] as number) << 8; pos += 1; }
      if (op & 0x04) { offset |= (delta[pos] as number) << 16; pos += 1; }
      if (op & 0x08) { offset |= (delta[pos] as number) << 24; pos += 1; }
      if (op & 0x10) { size = delta[pos] as number; pos += 1; }
      if (op & 0x20) { size |= (delta[pos] as number) << 8; pos += 1; }
      if (op & 0x40) { size |= (delta[pos] as number) << 16; pos += 1; }
      if (size === 0) size = 0x10000;
      chunks.push(base.subarray(offset, offset + size));
    } else if (op !== 0) {
      chunks.push(delta.subarray(pos, pos + op));
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(chunks);
  if (out.length !== dstSize) throw new Error('delta result size mismatch');
  return out;
}

/**
 * Parse a pack file. Returns the objects in pack order. OFS_DELTA and
 * REF_DELTA entries are resolved (ref-delta bases may come from `external`,
 * i.e. objects the server already holds, for thin packs).
 */
function readPack(pack: Buffer, external?: Map<string, GitObject>): Map<string, GitObject> {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  const count = pack.readUInt32BE(8);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const trailer = pack.subarray(pack.length - 20);
  const expected = sha1Hex(pack.subarray(0, pack.length - 20));
  if (trailer.toString('hex') !== expected) throw new Error('pack trailer checksum mismatch');
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  const deferred: Array<{ offset: number; typeNum: number; data: Buffer; baseOid?: string; baseOffset?: number }> = [];
  let offset = 12;
  for (let n = 0; n < count; n += 1) {
    const entryOffset = offset;
    const first = pack[offset] as number;
    const typeNum = (first >> 4) & 0x07;
    const header = readVarint(pack, offset);
    offset = header.next;
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (typeNum === 6) {
      // OFS_DELTA: negative offset varint
      let b = pack[offset] as number;
      offset += 1;
      let base = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset] as number;
        offset += 1;
        base = ((base + 1) << 7) | (b & 0x7f);
      }
      baseOffset = entryOffset - base;
    } else if (typeNum === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    // Find the compressed length by binary search: inflateSync ignores
    // trailing bytes and throws on truncation, so the predicate is monotone.
    const expectedSize = header.value;
    let lo = offset;
    let hi = pack.length - 20;
    let data: Buffer | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      try {
        const out = zlib.inflateSync(pack.subarray(offset, mid));
        if (out.length === expectedSize) {
          data = out;
          hi = mid - 1;
        } else if (out.length < expectedSize) {
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      } catch {
        lo = mid + 1;
      }
    }
    if (data === null) {
      // Fall back: inflate the rest; the entry must end at the trailer.
      data = zlib.inflateSync(pack.subarray(offset, pack.length - 20));
      if (data.length !== expectedSize) throw new Error('pack entry size mismatch');
      offset = pack.length - 20;
    } else {
      // Recompute the exact end with the minimal length found.
      offset = lo;
    }
    if (typeNum >= 1 && typeNum <= 4) {
      const type = PACK_TYPES[typeNum] as ObjType;
      const oid = objectId(type, data);
      const obj: GitObject = { type, data };
      objects.set(oid, obj);
      byOffset.set(entryOffset, obj);
    } else if (typeNum === 6 || typeNum === 7) {
      deferred.push({ offset: entryOffset, typeNum, data, baseOid, baseOffset });
    } else {
      throw new Error(`unknown pack entry type ${typeNum}`);
    }
  }
  // Resolve deltas (bases may appear later in the pack, so loop to fixpoint).
  for (let guard = 0; guard < deferred.length + 2; guard += 1) {
    let progressed = false;
    for (const d of deferred) {
      if (d.data === null) continue;
      let base: GitObject | undefined;
      if (d.typeNum === 6) base = byOffset.get(d.baseOffset as number);
      else base = objects.get(d.baseOid as string) ?? external?.get(d.baseOid as string);
      if (!base) continue;
      const resolved = applyDelta(base.data, d.data);
      const oid = objectId(base.type, resolved);
      const obj: GitObject = { type: base.type, data: resolved };
      objects.set(oid, obj);
      byOffset.set(d.offset, obj);
      (d as { data: Buffer | null }).data = null;
      progressed = true;
    }
    if (!progressed) break;
  }
  for (const d of deferred) {
    if (d.data !== null) throw new Error('unresolved delta in pack');
  }
  return objects;
}

/** Serialize `oids` (from `objects`) as a pack with plain deflated entries. */
function writePack(objects: Map<string, GitObject>, oids: string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  const body = Buffer.concat(parts);
  const chunks: Buffer[] = [body];
  for (const oid of oids) {
    const obj = objects.get(oid);
    if (!obj) continue;
    const typeId = PACK_TYPE_IDS[obj.type];
    const size = obj.data.length;
    const headerBytes: number[] = [];
    let first = (typeId << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest > 0) first |= 0x80;
    headerBytes.push(first);
    while (rest > 0) {
      let b = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) b |= 0x80;
      headerBytes.push(b);
    }
    chunks.push(Buffer.from(headerBytes));
    chunks.push(zlib.deflateSync(obj.data, { level: 6 }));
  }
  const payload = Buffer.concat(chunks);
  const trailer = Buffer.from(sha1Hex(payload), 'hex');
  return Buffer.concat([payload, trailer]);
}

// ---------------------------------------------------------------- the store

interface Label {
  name: string;
  color: string;
}

interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  comments: Comment[];
}

interface Comment {
  id: number;
  body: string;
  seq: number;
}

interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

interface Repo {
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  id: number;
  seq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // full ref name -> commit oid
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  nextNumber: number;
  nextCommentId: number;
}

const repos = new Map<string, Repo>(); // keyed by repo name; owner is always the viewer
let nextRepoId = 5000;
let nextIssueId = 10000;

function repoKey(owner: string, name: string): string | null {
  // A repo belongs to the token's login; any other owner is a 404, never a 403.
  if (owner !== VIEWER_LOGIN) return null;
  return name;
}

function getRepo(owner: string, name: string): Repo | null {
  const key = repoKey(owner, name);
  if (key === null) return null;
  return repos.get(key) ?? null;
}

function createRepo(name: string, description: string, isPrivate: boolean): Repo {
  const repo: Repo = {
    name,
    owner: VIEWER_LOGIN,
    description,
    isPrivate,
    id: nextRepoId,
    seq: nextSeq(),
    objects: new Map(),
    refs: new Map(),
    issues: new Map(),
    pulls: new Map(),
    labels: new Map(),
    nextNumber: 1,
    nextCommentId: 1,
  };
  nextRepoId += 1;
  // Labels start empty: they are created through POST /labels.
  repos.set(name, repo);
  return repo;
}

function refTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

function branchNames(repo: Repo): string[] {
  const out: string[] = [];
  for (const ref of repo.refs.keys()) {
    if (ref.startsWith('refs/heads/')) out.push(ref.slice('refs/heads/'.length));
  }
  return out.sort();
}

/** Create a commit on `branch` from `treeOid` with `parent` (null for root). */
function makeCommit(repo: Repo, branch: string, treeOid: string, parent: string | null, message: string): string {
  const seq = nextSeq();
  const epoch = BASE_EPOCH + seq;
  const identity = gitIdentity(epoch);
  const data = encodeCommit(treeOid, parent ? [parent] : [], identity, identity, message);
  const oid = storeObject(repo.objects, 'commit', data);
  repo.refs.set(`refs/heads/${branch}`, oid);
  return oid;
}

/** Resolve a ref name, branch name or full oid to a commit oid, or null. */
function resolveRef(repo: Repo, ref: string): string | null {
  if (isOid(ref)) return repo.objects.has(ref) ? ref : null;
  if (ref === 'HEAD') return refTip(repo, DEFAULT_BRANCH);
  if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
  const tip = refTip(repo, ref);
  if (tip !== null) return tip;
  return null;
}

function commitAt(repo: Repo, ref: string): { oid: string; info: CommitInfo } | null {
  const oid = resolveRef(repo, ref);
  if (oid === null) return null;
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return null;
  return { oid, info: parseCommit(obj.data) };
}

/** Line counts for a blob's content (used for PR file stats). */
function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) n += 1;
  if (data[data.length - 1] !== 0x0a) n += 1;
  return n;
}

function lineMultiset(data: Buffer): Map<string, number> {
  const counts = new Map<string, number>();
  const text = data.toString('utf8');
  for (const line of text.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** Diff two trees (flat path maps) into per-file changes. */
function diffTrees(repo: Repo, baseTree: string, headTree: string): FileChange[] {
  const base = new Map<string, { oid: string; mode: string }>();
  const head = new Map<string, { oid: string; mode: string }>();
  flattenTree(repo.objects, baseTree, '', base);
  flattenTree(repo.objects, headTree, '', head);
  const out: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) {
      const data = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
      const deletions = countLines(data);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (!b && h) {
      const data = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
      const additions = countLines(data);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b && h && b.oid !== h.oid) {
      const oldData = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
      const newData = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
      const oldLines = lineMultiset(oldData);
      const newLines = lineMultiset(newData);
      let additions = 0;
      let deletions = 0;
      for (const [line, count] of newLines) {
        const diff = count - (oldLines.get(line) ?? 0);
        if (diff > 0) additions += diff;
      }
      for (const [line, count] of oldLines) {
        const diff = count - (newLines.get(line) ?? 0);
        if (diff > 0) deletions += diff;
      }
      if (additions === 0 && deletions === 0) { additions = 1; }
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

/** Whether a pull request's head conflicts with its base (both changed the same file differently since the merge-base). */
function prConflict(repo: Repo, pull: Pull): boolean {
  const head = commitAt(repo, pull.headRef);
  const base = commitAt(repo, pull.baseRef);
  if (!head || !base) return false;
  const mb = mergeBase(repo.objects, head.oid, base.oid);
  if (mb === null) return false;
  const mbObj = repo.objects.get(mb);
  if (!mbObj || mbObj.type !== 'commit') return false;
  const mbTree = parseCommit(mbObj.data).tree;
  const headChanges = diffTrees(repo, mbTree, head.info.tree);
  const baseChanges = diffTrees(repo, mbTree, base.info.tree);
  const baseChanged = new Map<string, string>();
  for (const c of baseChanges) baseChanged.set(c.filename, c.status);
  for (const c of headChanges) {
    if (!baseChanged.has(c.filename)) continue;
    const headFlat = new Map<string, { oid: string; mode: string }>();
    const baseFlat = new Map<string, { oid: string; mode: string }>();
    flattenTree(repo.objects, head.info.tree, '', headFlat);
    flattenTree(repo.objects, base.info.tree, '', baseFlat);
    const hOid = headFlat.get(c.filename)?.oid;
    const bOid = baseFlat.get(c.filename)?.oid;
    if (hOid !== bOid) return true;
  }
  return false;
}

/** Squash-merge a pull request onto its base branch. Returns the merge commit oid, or null when conflicted. */
function squashMerge(repo: Repo, pull: Pull): string | null {
  if (prConflict(repo, pull)) return null;
  const head = commitAt(repo, pull.headRef);
  const base = commitAt(repo, pull.baseRef);
  if (!head || !base) return null;
  const seq = nextSeq();
  const epoch = BASE_EPOCH + seq;
  const identity = gitIdentity(epoch);
  const message = `${pull.title} (#${pull.number})\n\n${pull.body}`.trimEnd();
  const data = encodeCommit(head.info.tree, [base.oid], identity, identity, message);
  const oid = storeObject(repo.objects, 'commit', data);
  repo.refs.set(`refs/heads/${pull.baseRef}`, oid);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = isoFromSeq(seq);
  pull.mergeCommitSha = oid;
  return oid;
}

// ---------------------------------------------------------------- HTTP plumbing

interface ReqCtx {
  method: string;
  url: URL;
  pathname: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  params: Record<string, string>;
}

function sendJson(res: http.ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = value === null ? '' : jsonStringify(value);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-request-id': `req-${nextSeq()}`,
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(text);
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(ctx: ReqCtx): { ok: true; value: unknown } | { ok: false } {
  if (ctx.body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(ctx.body.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function authorized(ctx: ReqCtx): boolean {
  const auth = ctx.headers.authorization ?? '';
  if (TOKEN === '') return auth.startsWith('Bearer ') && auth.length > 7;
  return auth === `Bearer ${TOKEN}`;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function strField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === 'string' ? v : '';
}

function intField(obj: Record<string, unknown>, key: string, fallback: number): number {
  const v = obj[key];
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return parseInt(v, 10);
  return fallback;
}

// ---------------------------------------------------------------- REST shapes

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', `${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: DEFAULT_BRANCH,
    html_url: `https://github.invalid/${repo.owner}/${repo.name}`,
    url: `/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://github.invalid/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.invalid:${repo.owner}/${repo.name}.git`,
    homepage: null,
    language: null,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    fork: false,
    archived: false,
    disabled: false,
    created_at: isoFromSeq(repo.seq),
    updated_at: isoFromSeq(repo.seq),
    pushed_at: isoFromSeq(repo.seq),
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: 10000 + issue.seq,
    node_id: globalId('Issue', `${repo.owner}/${repo.name}/${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: '' };
    }),
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    locked: false,
    milestone: null,
    created_at: isoFromSeq(issue.seq),
    updated_at: isoFromSeq(issue.seq),
    closed_at: issue.state === 'closed' ? isoFromSeq(issue.seq) : null,
    html_url: `https://github.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const head = commitAt(repo, pull.headRef);
  const base = commitAt(repo, pull.baseRef);
  const headSha = head?.oid ?? pull.headSha;
  const baseSha = base?.oid ?? pull.baseSha;
  return {
    id: 20000 + pull.seq,
    node_id: globalId('PullRequest', `${repo.owner}/${repo.name}/${pull.number}`),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: headSha },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: baseSha },
    merged: pull.merged,
    mergeable: pull.state === 'open' ? !prConflict(repo, pull) : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    created_at: isoFromSeq(pull.seq),
    updated_at: isoFromSeq(pull.seq),
    closed_at: pull.state === 'closed' ? isoFromSeq(pull.seq) : null,
    html_url: `https://github.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', `${repo.owner}/${repo.name}/${issue.number}/${comment.id}`),
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: isoFromSeq(comment.seq),
    updated_at: isoFromSeq(comment.seq),
    html_url: `https://github.invalid/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

// ---------------------------------------------------------------- git smart HTTP

function allRefs(repo: Repo): Array<{ name: string; oid: string; peeled?: string }> {
  const out: Array<{ name: string; oid: string; peeled?: string }> = [];
  const head = refTip(repo, DEFAULT_BRANCH);
  out.push({ name: 'HEAD', oid: head ?? ZERO_OID });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const obj = repo.objects.get(oid);
    let peeled: string | undefined;
    if (obj && obj.type === 'tag') {
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
      if (m) peeled = m[1];
    }
    out.push({ name, oid, peeled });
  }
  return out;
}

function gitNotFound(res: http.ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function handleInfoRefs(ctx: ReqCtx, res: http.ServerResponse, owner: string, name: string, service: string): void {
  const repo = getRepo(owner, name);
  if (!repo) return gitNotFound(res);
  const wantV2 = service === 'git-upload-pack' && (ctx.headers['git-protocol'] ?? '') === 'version=2';
  const chunks: Buffer[] = [];
  const serviceLine = pktLine(`# service=${service}\n`);
  chunks.push(serviceLine, FLUSH);
  if (wantV2) {
    chunks.push(pktLine('version 2\n'));
    chunks.push(pktLine(`agent=${AGENT}\n`));
    chunks.push(pktLine('ls-refs=unborn\n'));
    chunks.push(pktLine('fetch=shallow wait-for-done\n'));
    chunks.push(pktLine('object-format=sha1\n'));
    chunks.push(FLUSH);
    res.writeHead(200, { 'content-type': `application/x-${service}-advertisement`, 'x-github-request-id': `req-${nextSeq()}` });
    res.end(Buffer.concat(chunks));
    return;
  }
  // v0 advertisement: first line carries the capabilities after NUL.
  const caps = service === 'git-upload-pack'
    ? `symref=HEAD:refs/heads/${DEFAULT_BRANCH} side-band-64k shallow thin-pack ofs-delta agent=${AGENT}`
    : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const refs = allRefs(repo);
  const hasCommits = refs.some((r) => r.name !== 'HEAD' && r.oid !== ZERO_OID);
  if (!hasCommits) {
    chunks.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((r, i) => {
      const line = i === 0 ? `${r.oid} ${r.name}\0${caps}\n` : `${r.oid} ${r.name}\n`;
      chunks.push(pktLine(line));
      if (r.peeled) chunks.push(pktLine(`${r.peeled} ${r.name}^{}\n`));
    });
  }
  chunks.push(FLUSH);
  res.writeHead(200, { 'content-type': `application/x-${service}-advertisement`, 'x-github-request-id': `req-${nextSeq()}` });
  res.end(Buffer.concat(chunks));
}

interface FetchPlan {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function planFetch(objects: Map<string, GitObject>, plan: FetchPlan): { send: Set<string>; newShallow: string[]; unshallow: string[] } {
  // Held set: reachable from haves, stopping at shallow boundaries. The
  // boundary commit itself and its tree/blobs are held; its parents are not.
  const held = new Set<string>();
  if (plan.haves.length > 0) {
    const boundary = new Set(plan.shallow);
    const stack = [...plan.haves];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (held.has(oid)) continue;
      const obj = objects.get(oid);
      if (!obj) continue;
      held.add(oid);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        if (c.tree !== '') stack.push(c.tree);
        if (boundary.has(oid)) continue;
        for (const p of c.parents) stack.push(p);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.oid);
      } else if (obj.type === 'tag') {
        const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
        if (m) stack.push(m[1] as string);
      }
    }
  }
  // Commits within depth generations of the wants (generation 0 = the wants).
  const included = new Set<string>();
  const newShallow = new Set<string>();
  if (plan.depth !== null) {
    const gen = commitGenerations(objects, plan.wants, plan.depth);
    for (const [oid, g] of gen) {
      if (g < plan.depth) {
        included.add(oid);
        if (g === plan.depth - 1) {
          const obj = objects.get(oid);
          if (obj && obj.type === 'commit' && parseCommit(obj.data).parents.length > 0) newShallow.add(oid);
        }
      }
    }
  } else {
    for (const oid of collectReachable(objects, plan.wants)) included.add(oid);
  }
  // Expand the included commits to their trees and blobs WITHOUT following
  // parent links: a depth-limited fetch must not carry older history.
  const send = new Set<string>();
  const expandCommit = (commitOid: string): void => {
    if (send.has(commitOid)) return;
    send.add(commitOid);
    const obj = objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return;
    const stack = [parseCommit(obj.data).tree];
    while (stack.length > 0) {
      const t = stack.pop() as string;
      if (t === '' || send.has(t)) continue;
      const tobj = objects.get(t);
      if (!tobj) continue;
      send.add(t);
      if (tobj.type === 'tree') for (const e of parseTree(tobj.data)) stack.push(e.oid);
    }
  };
  for (const oid of included) {
    const obj = objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'commit') expandCommit(oid);
    else if (obj.type === 'tag') {
      send.add(oid);
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
      if (m) {
        const target = m[1] as string;
        const tobj = objects.get(target);
        if (tobj) {
          if (tobj.type === 'commit') expandCommit(target);
          else send.add(target);
        }
      }
    } else {
      send.add(oid);
    }
  }
  for (const oid of held) send.delete(oid);
  // Old boundaries that are now included (and no longer boundaries) unshallow.
  const unshallow: string[] = [];
  for (const b of plan.shallow) {
    if (included.has(b) && !newShallow.has(b)) unshallow.push(b);
  }
  return { send, newShallow: [...newShallow].sort(), unshallow: unshallow.sort() };
}

function sidebandPack(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let i = 0;
  while (i < pack.length) {
    const slice = pack.subarray(i, Math.min(pack.length, i + 65515));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    chunks.push(pktLine(payload));
    i += slice.length;
  }
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

function handleUploadPack(ctx: ReqCtx, res: http.ServerResponse, owner: string, name: string): void {
  const repo = getRepo(owner, name);
  if (!repo) return gitNotFound(res);
  const isV2 = (ctx.headers['git-protocol'] ?? '') === 'version=2';
  try {
    const packets = decodePktLines(ctx.body);
    if (isV2) return handleUploadPackV2(ctx, res, repo, packets);
    return handleUploadPackV0(ctx, res, repo, packets);
  } catch (e) {
    // A malformed upload-pack POST must not crash the server.
    sendJson(res, 400, { message: `malformed upload-pack request: ${e instanceof Error ? e.message : 'bad request'}` });
  }
}

function handleUploadPackV2(ctx: ReqCtx, res: http.ServerResponse, repo: Repo, packets: Pkt[]): void {
  const lines: string[] = [];
  for (const p of packets) {
    if (p.kind === 'data') lines.push(p.payload.toString('utf8').replace(/\n$/, ''));
  }
  const commandLine = lines[0] ?? '';
  const command = commandLine.startsWith('command=') ? commandLine.slice('command='.length) : '';
  const args = lines.slice(1);
  if (command === 'ls-refs') {
    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];
    for (const arg of args) {
      if (arg === 'peel') peel = true;
      else if (arg === 'symrefs') symrefs = true;
      else if (arg === 'unborn') unborn = true;
      else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
    }
    const chunks: Buffer[] = [];
    const head = refTip(repo, DEFAULT_BRANCH);
    const refs = allRefs(repo);
    const keep = (refName: string): boolean => prefixes.length === 0 || prefixes.some((p) => refName.startsWith(p));
    // HEAD symref line (only when no prefix excludes it).
    if (keep('HEAD')) {
      const target = `refs/heads/${DEFAULT_BRANCH}`;
      const line = head !== null
        ? `${head} HEAD${symrefs ? ` symref-target:${target}` : ''}`
        : `unborn HEAD${symrefs ? ` symref-target:${target}` : ''}`;
      chunks.push(pktLine(`${line}\n`));
    }
    for (const r of refs) {
      if (r.name === 'HEAD') continue;
      if (!keep(r.name)) continue;
      const unbornRef = r.oid === ZERO_OID;
      if (unbornRef && !unborn) continue;
      if (unbornRef) {
        chunks.push(pktLine(`unborn ${r.name}${symrefs && r.name === `refs/heads/${DEFAULT_BRANCH}` ? ` symref-target:refs/heads/${DEFAULT_BRANCH}` : ''}\n`));
        continue;
      }
      let line = `${r.oid} ${r.name}`;
      if (peel && r.peeled) line += ` peeled:${r.peeled}`;
      chunks.push(pktLine(`${line}\n`));
    }
    // An unborn branch is reported only through the HEAD line above: the
    // branch ref itself does not exist yet and must not be listed.
    chunks.push(FLUSH);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'x-github-request-id': `req-${nextSeq()}` });
    res.end(Buffer.concat(chunks));
    return;
  }
  if (command === 'fetch') {
    const plan: FetchPlan = { wants: [], haves: [], shallow: [], depth: null };
    for (const arg of args) {
      if (arg.startsWith('want ')) plan.wants.push(arg.slice(5).trim());
      else if (arg.startsWith('have ')) plan.haves.push(arg.slice(5).trim());
      else if (arg.startsWith('shallow ')) plan.shallow.push(arg.slice(8).trim());
      else if (arg.startsWith('deepen ')) plan.depth = parseInt(arg.slice(7).trim(), 10);
    }
    const { send, newShallow, unshallow } = planFetch(repo.objects, plan);
    const pack = writePack(repo.objects, [...send].sort());
    const chunks: Buffer[] = [];
    // The acknowledgments section is only sent when the client sent 'have'
    // lines; a fresh clone (no haves) goes straight to the packfile section.
    // A held have is ACKed (with 'ready'); only an unknown have gets NAK.
    if (plan.haves.length > 0) {
      const common = plan.haves.find((oid) => repo.objects.has(oid));
      chunks.push(pktLine('acknowledgments\n'));
      if (common !== undefined) {
        chunks.push(pktLine(`ACK ${common}\n`), pktLine('ready\n'));
      } else {
        chunks.push(pktLine('NAK\n'));
      }
      chunks.push(DELIM);
    }
    if (newShallow.length > 0 || unshallow.length > 0) {
      chunks.push(pktLine('shallow-info\n'));
      for (const oid of newShallow) chunks.push(pktLine(`shallow ${oid}\n`));
      for (const oid of unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
      chunks.push(DELIM);
    }
    chunks.push(pktLine('packfile\n'));
    chunks.push(sidebandPack(pack));
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'x-github-request-id': `req-${nextSeq()}` });
    res.end(Buffer.concat(chunks));
    return;
  }
  sendJson(res, 400, { message: `unknown upload-pack v2 command: ${command}` });
}

function handleUploadPackV0(ctx: ReqCtx, res: http.ServerResponse, repo: Repo, packets: Pkt[]): void {
  const lines: string[] = [];
  for (const p of packets) {
    if (p.kind === 'data') lines.push(p.payload.toString('utf8').replace(/\n$/, ''));
  }
  const plan: FetchPlan = { wants: [], haves: [], shallow: [], depth: null };
  for (const line of lines) {
    if (line.startsWith('want ')) {
      const rest = line.slice(5).trim().split(/\s+/);
      if (rest[0]) plan.wants.push(rest[0]);
    } else if (line.startsWith('have ')) plan.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) plan.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) plan.depth = parseInt(line.slice(7).trim(), 10);
  }
  const { send, newShallow, unshallow } = planFetch(repo.objects, plan);
  const pack = writePack(repo.objects, [...send].sort());
  const chunks: Buffer[] = [];
  const common = plan.haves.find((oid) => repo.objects.has(oid));
  chunks.push(pktLine(common !== undefined ? `ACK ${common}\n` : 'NAK\n'));
  for (const oid of newShallow) chunks.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
  chunks.push(sidebandPack(pack));
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'x-github-request-id': `req-${nextSeq()}` });
  res.end(Buffer.concat(chunks));
}

/** Decode pkt-lines up to and including the first flush, returning the packets and the byte offset just past the flush. */
function decodePktLinesUntilFlush(buf: Buffer): { packets: Pkt[]; nextOffset: number } {
  const packets: Pkt[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.subarray(i, i + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error(`bad pkt-line length at ${i}`);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      return { packets, nextOffset: i + 4 };
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      i += 4;
    } else if (len === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      i += 4;
    } else {
      if (i + len > buf.length) throw new Error('truncated pkt-line');
      packets.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
      i += len;
    }
  }
  throw new Error('no flush after pkt-lines');
}

function handleReceivePack(ctx: ReqCtx, res: http.ServerResponse, owner: string, name: string): void {
  const repo = getRepo(owner, name);
  if (!repo) return gitNotFound(res);
  try {
    const { packets, nextOffset } = decodePktLinesUntilFlush(ctx.body);
    const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
    for (const p of packets) {
      if (p.kind !== 'data') continue;
      let line = p.payload.toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\0');
      if (nul >= 0) line = line.slice(0, nul);
      const parts = line.split(' ');
      if (parts.length < 3) throw new Error(`bad receive-pack command: ${line}`);
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
    }
    const packBytes = ctx.body.subarray(nextOffset);
    const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
    let unpackOk = true;
    const hasUpdates = commands.some((c) => c.newOid !== ZERO_OID);
    if (hasUpdates) {
      if (packBytes.length < 12) throw new Error('missing pack in receive-pack');
      const incoming = readPack(packBytes, repo.objects);
      for (const [oid, obj] of incoming) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    }
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          results.push({ ref: cmd.ref, ok: false, reason: 'reference does not exist' });
        } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
          results.push({ ref: cmd.ref, ok: false, reason: 'old value mismatch' });
        } else {
          repo.refs.delete(cmd.ref);
          results.push({ ref: cmd.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (current === undefined) {
        if (cmd.oldOid !== ZERO_OID) {
          results.push({ ref: cmd.ref, ok: false, reason: 'old value mismatch' });
          continue;
        }
        repo.refs.set(cmd.ref, cmd.newOid);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
        continue;
      }
      if (cmd.oldOid !== current) {
        results.push({ ref: cmd.ref, ok: false, reason: 'old value mismatch' });
        continue;
      }
      if (!isAncestor(repo.objects, cmd.newOid, current)) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
    }
    // The report lines are pkt-lines themselves, wrapped in one sideband
    // packet, and the demultiplexed stream ends with a flush so the
    // client's report reader terminates cleanly instead of hitting EOF.
    const reportLines: Buffer[] = [pktLine(`unpack ${unpackOk ? 'ok' : 'error'}\n`)];
    for (const r of results) {
      reportLines.push(pktLine(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`));
    }
    reportLines.push(FLUSH);
    const report = Buffer.concat(reportLines);
    const chunks: Buffer[] = [pktLine(Buffer.concat([Buffer.from([1]), report])), FLUSH];
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'x-github-request-id': `req-${nextSeq()}` });
    res.end(Buffer.concat(chunks));
  } catch (e) {
    sendJson(res, 400, { message: `malformed receive-pack request: ${e instanceof Error ? e.message : 'bad request'}` });
  }
}

// ---------------------------------------------------------------- REST v3

function parsePagination(ctx: ReqCtx): { page: number; perPage: number } {
  const page = Math.max(1, intField(Object.fromEntries(ctx.url.searchParams.entries()), 'page', 1));
  const perPage = Math.min(100, Math.max(1, intField(Object.fromEntries(ctx.url.searchParams.entries()), 'per_page', 30)));
  return { page, perPage };
}

function pageLink(ctx: ReqCtx, page: number, perPage: number, rel: string): string {
  const url = new URL(ctx.url.toString());
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(perPage));
  return `<${url.toString()}>; rel="${rel}"`;
}

function paged<T>(ctx: ReqCtx, res: http.ServerResponse, items: T[]): void {
  const { page, perPage } = parsePagination(ctx);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const links: string[] = [];
  if (page < totalPages) links.push(pageLink(ctx, page + 1, perPage, 'next'));
  if (page > 1) links.push(pageLink(ctx, page - 1, perPage, 'prev'));
  links.push(pageLink(ctx, 1, perPage, 'first'));
  links.push(pageLink(ctx, totalPages, perPage, 'last'));
  sendJson(res, 200, slice, { link: links.join(', ') });
}

function createIssueInRepo(repo: Repo, title: string, body: string, labels: string[]): { issue: Issue | null; unknownLabel: string | null } {
  for (const name of labels) {
    if (!repo.labels.has(name)) return { issue: null, unknownLabel: name };
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: Issue = { number, title, body, state: 'open', labels: [...labels], seq: nextSeq(), comments: [] };
  repo.issues.set(number, issue);
  return { issue, unknownLabel: null };
}

function createPullInRepo(repo: Repo, title: string, body: string, head: string, base: string): { pull: Pull | null; error: string | null } {
  const headTip = refTip(repo, head);
  if (headTip === null) return { pull: null, error: `head branch ${head} does not exist` };
  const baseTip = refTip(repo, base);
  if (baseTip === null) return { pull: null, error: `base branch ${base} does not exist` };
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pull: Pull = {
    number, title, body, state: 'open', headRef: head, baseRef: base,
    headSha: headTip, baseSha: baseTip, merged: false, mergedAt: null, mergeCommitSha: null, seq: nextSeq(),
  };
  repo.pulls.set(number, pull);
  return { pull, error: null };
}

function handleRest(ctx: ReqCtx, res: http.ServerResponse): void {
  const path = ctx.pathname.slice('/api/v3'.length) || '/';
  const method = ctx.method;

  // Root and meta: no repo involved.
  if (path === '/' && method === 'GET') {
    return sendJson(res, 200, {}, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (path === '/meta' && method === 'GET') {
    return sendJson(res, 200, { installed_version: SERVER_VERSION });
  }
  if (path === '/user' && method === 'GET') {
    return sendJson(res, 200, {
      login: VIEWER_LOGIN, id: VIEWER_ID, node_id: globalId('User', VIEWER_LOGIN),
      name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User',
    });
  }
  if (path === '/user/repos' && method === 'GET') {
    const list = [...repos.values()].sort((a, b) => a.seq - b.seq).map(repoJson);
    return paged(ctx, res, list);
  }
  if (path === '/user/repos' && method === 'POST') {
    const parsed = parseJsonBody(ctx);
    if (!parsed.ok) return sendError(res, 400, 'malformed JSON body');
    const body = recordOf(parsed.value);
    if (!body) return sendError(res, 400, 'malformed JSON body');
    const name = strField(body, 'name');
    if (name === '' || !/^[A-Za-z0-9._-]+$/.test(name)) return sendError(res, 422, 'name is invalid');
    if (repos.has(name)) return sendError(res, 422, 'name already exists on this account');
    const repo = createRepo(name, strField(body, 'description'), body.private === true);
    return sendJson(res, 201, repoJson(repo));
  }

  // /repos/{owner}/{name}/...
  const repoMatch = path.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (repoMatch) {
    const owner = decodeURIComponent(repoMatch[1] as string);
    const name = decodeURIComponent(repoMatch[2] as string);
    const rest = repoMatch[3] ?? '';
    return handleRepoRest(ctx, res, owner, name, rest);
  }

  return sendError(res, 404, 'Not Found');
}

function handleRepoRest(ctx: ReqCtx, res: http.ServerResponse, owner: string, name: string, rest: string): void {
  const method = ctx.method;
  const repo = getRepo(owner, name);

  // Repo-level routes that need the repo to exist.
  if (rest === '' || rest === '/') {
    if (method === 'GET') {
      if (!repo) return sendError(res, 404, 'Not Found');
      return sendJson(res, 200, repoJson(repo));
    }
    if (method === 'PATCH') {
      if (!repo) return sendError(res, 404, 'Not Found');
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return sendError(res, 400, 'malformed JSON body');
      const body = recordOf(parsed.value);
      if (!body) return sendError(res, 400, 'malformed JSON body');
      if (typeof body.description === 'string') repo.description = body.description;
      if (body.private === true || body.private === false) repo.isPrivate = body.private;
      return sendJson(res, 200, repoJson(repo));
    }
    if (method === 'DELETE') {
      if (!repo) return sendError(res, 404, 'Not Found');
      repos.delete(name);
      res.writeHead(204, { 'x-github-request-id': `req-${nextSeq()}` });
      res.end();
      return;
    }
    return sendError(res, 404, 'Not Found');
  }

  if (!repo) return sendError(res, 404, 'Not Found');

  // Git Data: refs.
  if (rest === '/git/refs' && method === 'POST') {
    const parsed = parseJsonBody(ctx);
    if (!parsed.ok) return sendError(res, 400, 'malformed JSON body');
    const body = recordOf(parsed.value);
    if (!body) return sendError(res, 400, 'malformed JSON body');
    const ref = strField(body, 'ref');
    const sha = strField(body, 'sha');
    if (!ref.startsWith('refs/') || !isOid(sha)) return sendError(res, 422, 'invalid ref or sha');
    if (repo.refs.has(ref)) return sendError(res, 422, 'Reference already exists');
    if (!repo.objects.has(sha)) return sendError(res, 422, 'object does not exist');
    repo.refs.set(ref, sha);
    return sendJson(res, 201, { ref, object: { sha, type: 'commit' }, url: `/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}` });
  }
  const refMatch = rest.match(/^\/git\/refs\/(.+)$/);
  if (refMatch && method === 'GET') {
    const ref = decodeURIComponent(refMatch[1] as string);
    const sha = repo.refs.get(ref);
    if (sha === undefined) return sendError(res, 404, 'Not Found');
    return sendJson(res, 200, { ref, object: { sha, type: 'commit' }, url: `/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}` });
  }

  // Branches.
  if (rest === '/branches' && method === 'GET') {
    const list = branchNames(repo).map((b) => ({
      name: b,
      commit: { sha: refTip(repo, b) as string },
      protected: false,
    }));
    return sendJson(res, 200, list);
  }
  const branchMatch = rest.match(/^\/branches\/([^/]+)$/);
  if (branchMatch && method === 'GET') {
    const branch = decodeURIComponent(branchMatch[1] as string);
    const tip = refTip(repo, branch);
    if (tip === null) return sendError(res, 404, 'Not Found');
    return sendJson(res, 200, { name: branch, commit: { sha: tip }, protected: false });
  }

  // Commits.
  if (rest === '/commits' && method === 'GET') {
    const shaParam = ctx.url.searchParams.get('sha') ?? DEFAULT_BRANCH;
    const tip = resolveRef(repo, shaParam);
    if (tip === null) return sendError(res, 404, 'Not Found');
    const reachable = collectReachable(repo.objects, [tip]);
    const generations = commitGenerations(repo.objects, [tip]);
    const commits: Array<{ sha: string; gen: number }> = [];
    for (const oid of reachable) {
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'commit') commits.push({ sha: oid, gen: generations.get(oid) ?? 0 });
    }
    // Newest first: sort by generation ascending (tip first), then by oid for stability.
    commits.sort((a, b) => (a.gen - b.gen) || (a.sha < b.sha ? -1 : 1));
    const list = commits.map(({ sha }) => {
      const info = parseCommit((repo.objects.get(sha) as GitObject).data);
      const author = parseIdentity(info.author);
      const committer = parseIdentity(info.committer);
      return {
        sha,
        commit: {
          message: info.message,
          author,
          committer,
        },
        parents: info.parents.map((p) => ({ sha: p })),
        url: `/repos/${owner}/${name}/commits/${sha}`,
      };
    });
    return sendJson(res, 200, list);
  }

  // Contents.
  const contentsMatch = rest.match(/^\/contents(?:\/(.*))?$/);
  if (contentsMatch) {
    const rawPath = contentsMatch[1] === undefined ? '' : decodeURIComponent(contentsMatch[1]);
    return handleContents(ctx, res, repo, owner, name, rawPath);
  }

  // Labels.
  if (rest === '/labels' && method === 'POST') {
    const parsed = parseJsonBody(ctx);
    if (!parsed.ok) return sendError(res, 400, 'malformed JSON body');
    const body = recordOf(parsed.value);
    if (!body) return sendError(res, 400, 'malformed JSON body');
    const labelName = strField(body, 'name');
    if (labelName === '') return sendError(res, 422, 'name is required');
    const color = strField(body, 'color') || 'ededed';
    if (repo.labels.has(labelName)) return sendError(res, 422, 'Label already exists');
    const label: Label = { name: labelName, color };
    repo.labels.set(labelName, label);
    return sendJson(res, 201, { id: 30000 + repo.labels.size, name: labelName, color, description: '', default: false });
  }
  if (rest === '/labels' && method === 'GET') {
    return sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: '' })));
  }

  // Issues.
  if (rest === '/issues' && method === 'POST') {
    const parsed = parseJsonBody(ctx);
    if (!parsed.ok) return sendError(res, 400, 'malformed JSON body');
    const body = recordOf(parsed.value);
    if (!body) return sendError(res, 400, 'malformed JSON body');
    const title = strField(body, 'title');
    if (title === '') return sendError(res, 422, 'title is required');
    const rawLabels = Array.isArray(body.labels) ? body.labels : [];
    const labelNames: string[] = [];
    for (const l of rawLabels) {
      if (typeof l === 'string') labelNames.push(l);
      else if (recordOf(l)) labelNames.push(strField(recordOf(l) as Record<string, unknown>, 'name'));
    }
    const { issue, unknownLabel } = createIssueInRepo(repo, title, strField(body, 'body'), labelNames);
    if (issue === null) return sendError(res, 422, `Label does not exist: ${unknownLabel}`);
    return sendJson(res, 201, issueJson(repo, issue));
  }
  if (rest === '/issues' && method === 'GET') {
    const state = ctx.url.searchParams.get('state') ?? 'open';
    const sort = ctx.url.searchParams.get('sort') ?? 'created';
    const direction = ctx.url.searchParams.get('direction') ?? 'desc';
    let list = [...repo.issues.values()];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    if (sort === 'created') {
      list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
    }
    return paged(ctx, res, list.map((i) => issueJson(repo, i)));
  }
  const issueMatch = rest.match(/^\/issues\/(\d+)(\/comments)?$/);
  if (issueMatch) {
    const number = parseInt(issueMatch[1] as string, 10);
    const issue = repo.issues.get(number);
    if (!issue) return sendError(res, 404, 'Not Found');
    if (issueMatch[2] === '/comments') {
      if (method === 'GET') return sendJson(res, 200, issue.comments.map((c) => commentJson(repo, issue, c)));
      if (method === 'POST') {
        const parsed = parseJsonBody(ctx);
        if (!parsed.ok) return sendError(res, 400, 'malformed JSON body');
        const body = recordOf(parsed.value);
        if (!body) return sendError(res, 400, 'malformed JSON body');
        const comment: Comment = { id: repo.nextCommentId, body: strField(body, 'body'), seq: nextSeq() };
        repo.nextCommentId += 1;
        issue.comments.push(comment);
        return sendJson(res, 201, commentJson(repo, issue, comment));
      }
      return sendError(res, 404, 'Not Found');
    }
    if (method === 'GET') return sendJson(res, 200, issueJson(repo, issue));
    if (method === 'PATCH') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return sendError(res, 400, 'malformed JSON body');
      const body = recordOf(parsed.value);
      if (!body) return sendError(res, 400, 'malformed JSON body');
      if (body.state === 'closed' || body.state === 'open') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      return sendJson(res, 200, issueJson(repo, issue));
    }
    return sendError(res, 404, 'Not Found');
  }

  // Pull requests.
  if (rest === '/pulls' && method === 'POST') {
    const parsed = parseJsonBody(ctx);
    if (!parsed.ok) return sendError(res, 400, 'malformed JSON body');
    const body = recordOf(parsed.value);
    if (!body) return sendError(res, 400, 'malformed JSON body');
    const title = strField(body, 'title');
    if (title === '') return sendError(res, 422, 'title is required');
    const head = typeof body.head === 'string' ? body.head : strField(recordOf(body.head) ?? {}, 'ref');
    const base = typeof body.base === 'string' ? body.base : strField(recordOf(body.base) ?? {}, 'ref');
    const { pull, error } = createPullInRepo(repo, title, strField(body, 'body'), head, base || DEFAULT_BRANCH);
    if (pull === null) return sendError(res, 422, error as string);
    return sendJson(res, 201, pullJson(repo, pull));
  }
  if (rest === '/pulls' && method === 'GET') {
    const state = ctx.url.searchParams.get('state') ?? 'open';
    let list = [...repo.pulls.values()];
    if (state !== 'all') list = list.filter((p) => p.state === state);
    list.sort((a, b) => b.seq - a.seq);
    return paged(ctx, res, list.map((p) => pullJson(repo, p)));
  }
  const pullFilesMatch = rest.match(/^\/pulls\/(\d+)\/files$/);
  if (pullFilesMatch && method === 'GET') {
    const pull = repo.pulls.get(parseInt(pullFilesMatch[1] as string, 10));
    if (!pull) return sendError(res, 404, 'Not Found');
    const head = commitAt(repo, pull.headRef);
    const base = commitAt(repo, pull.baseRef);
    if (!head || !base) return sendError(res, 404, 'Not Found');
    const mb = mergeBase(repo.objects, head.oid, base.oid);
    const baseTree = mb !== null ? parseCommit((repo.objects.get(mb) as GitObject).data).tree : base.info.tree;
    const changes = diffTrees(repo, baseTree, head.info.tree);
    return sendJson(res, 200, changes.map((c) => ({
      filename: c.filename,
      status: c.status === 'removed' ? 'removed' : c.status,
      additions: c.additions,
      deletions: c.deletions,
      changes: c.changes,
    })));
  }
  const pullMergeMatch = rest.match(/^\/pulls\/(\d+)\/merge$/);
  if (pullMergeMatch && method === 'PUT') {
    const pull = repo.pulls.get(parseInt(pullMergeMatch[1] as string, 10));
    if (!pull) return sendError(res, 404, 'Not Found');
    if (pull.merged) return sendError(res, 405, 'Pull request has already been merged');
    if (pull.state !== 'open') return sendError(res, 405, 'Pull request is not open');
    const parsed = parseJsonBody(ctx);
    if (!parsed.ok) return sendError(res, 400, 'malformed JSON body');
    const body = recordOf(parsed.value) ?? {};
    const mergeMethod = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
    if (mergeMethod !== 'squash' && mergeMethod !== 'merge' && mergeMethod !== 'rebase') {
      return sendError(res, 422, 'invalid merge method');
    }
    const sha = squashMerge(repo, pull);
    if (sha === null) return sendError(res, 405, 'Merge conflict');
    return sendJson(res, 200, { sha, merged: true, message: 'Pull request successfully merged' });
  }
  if (pullMergeMatch && method === 'GET') {
    const pull = repo.pulls.get(parseInt(pullMergeMatch[1] as string, 10));
    if (!pull) return sendError(res, 404, 'Not Found');
    if (pull.merged) {
      res.writeHead(204, { 'x-github-request-id': `req-${nextSeq()}` });
      res.end();
      return;
    }
    return sendError(res, 404, 'Not Found');
  }
  const pullMatch = rest.match(/^\/pulls\/(\d+)$/);
  if (pullMatch && method === 'GET') {
    const pull = repo.pulls.get(parseInt(pullMatch[1] as string, 10));
    if (!pull) return sendError(res, 404, 'Not Found');
    return sendJson(res, 200, pullJson(repo, pull));
  }

  return sendError(res, 404, 'Not Found');
}

function handleContents(ctx: ReqCtx, res: http.ServerResponse, repo: Repo, owner: string, name: string, path: string): void {
  const method = ctx.method;
  const query = ctx.url.searchParams;
  const branch = query.get('branch') ?? query.get('ref') ?? DEFAULT_BRANCH;
  const bodyBranch = ((): string | null => {
    if (method !== 'PUT' && method !== 'DELETE') return null;
    const parsed = parseJsonBody(ctx);
    if (!parsed.ok) return '__badjson__';
    const body = recordOf(parsed.value);
    return body ? strField(body, 'branch') || null : null;
  })();
  if (bodyBranch === '__badjson__') return sendError(res, 400, 'malformed JSON body');
  const effectiveBranch = bodyBranch ?? branch;

  if (method === 'PUT') {
    const parsed = parseJsonBody(ctx);
    if (!parsed.ok) return sendError(res, 400, 'malformed JSON body');
    const body = recordOf(parsed.value);
    if (!body) return sendError(res, 400, 'malformed JSON body');
    const contentB64 = strField(body, 'content');
    if (contentB64 === '') return sendError(res, 422, 'content is required');
    let content: Buffer;
    try {
      content = b64decode(contentB64);
    } catch {
      return sendError(res, 422, 'content is not valid base64');
    }
    const message = strField(body, 'message') || `Update ${path}`;
    // The branch is created from the default tip when it does not exist yet.
    let tip = refTip(repo, effectiveBranch);
    if (tip === null && effectiveBranch !== DEFAULT_BRANCH) {
      const defaultTip = refTip(repo, DEFAULT_BRANCH);
      if (defaultTip !== null) {
        repo.refs.set(`refs/heads/${effectiveBranch}`, defaultTip);
        tip = defaultTip;
      }
    }
    const treeOid = tip === null ? '' : parseCommit((repo.objects.get(tip) as GitObject).data).tree;
    const flat = new Map<string, { oid: string; mode: string }>();
    flattenTree(repo.objects, treeOid, '', flat);
    const existing = flat.get(path);
    const sha = strField(body, 'sha');
    if (sha !== '' && existing && existing.oid !== sha) {
      return sendError(res, 409, 'sha does not match the current file');
    }
    const blobOid = storeObject(repo.objects, 'blob', content);
    const newTree = treeWithFile(repo.objects, treeOid, path, blobOid);
    const commitOid = makeCommit(repo, effectiveBranch, newTree, tip, message);
    const isCreate = existing === undefined;
    return sendJson(res, isCreate ? 201 : 200, {
      content: {
        name: path.split('/').pop() ?? path,
        path,
        sha: blobOid,
        size: content.length,
        type: 'file',
        encoding: 'base64',
        content: contentB64,
      },
      commit: { sha: commitOid, message },
    });
  }

  if (method === 'DELETE') {
    const parsed = parseJsonBody(ctx);
    if (!parsed.ok) return sendError(res, 400, 'malformed JSON body');
    const body = recordOf(parsed.value);
    if (!body) return sendError(res, 400, 'malformed JSON body');
    const tip = refTip(repo, effectiveBranch);
    if (tip === null) return sendError(res, 404, 'Not Found');
    const treeOid = parseCommit((repo.objects.get(tip) as GitObject).data).tree;
    const flat = new Map<string, { oid: string; mode: string }>();
    flattenTree(repo.objects, treeOid, '', flat);
    const existing = flat.get(path);
    if (!existing) return sendError(res, 404, 'Not Found');
    const message = strField(body, 'message') || `Delete ${path}`;
    const newTree = treeWithFile(repo.objects, treeOid, path, null);
    const commitOid = makeCommit(repo, effectiveBranch, newTree, tip, message);
    return sendJson(res, 200, { commit: { sha: commitOid, message } });
  }

  if (method === 'GET') {
    const tip = refTip(repo, effectiveBranch);
    if (tip === null) return sendError(res, 404, 'Not Found');
    const treeOid = parseCommit((repo.objects.get(tip) as GitObject).data).tree;
    if (path === '') {
      const entries = parseTree((repo.objects.get(treeOid) as GitObject).data);
      return sendJson(res, 200, entries.map((e) => ({
        type: e.mode === '40000' ? 'dir' : 'file',
        name: e.name,
        path: e.name,
        sha: e.oid,
        size: e.mode === '40000' ? 0 : ((repo.objects.get(e.oid)?.data.length) ?? 0),
      })));
    }
    const flat = new Map<string, { oid: string; mode: string }>();
    flattenTree(repo.objects, treeOid, '', flat);
    const file = flat.get(path);
    if (file) {
      const data = (repo.objects.get(file.oid) as GitObject).data;
      return sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        content: b64encode(data),
        sha: file.oid,
        size: data.length,
        name: path.split('/').pop() ?? path,
        path,
      });
    }
    // A directory: list the entries directly under it.
    const prefix = `${path}/`;
    const children = new Map<string, { mode: string; oid: string }>();
    for (const [p, entry] of flat) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) children.set(rest, { mode: 'file', oid: entry.oid });
      else children.set(rest.slice(0, slash), { mode: 'dir', oid: '' });
    }
    if (children.size === 0) return sendError(res, 404, 'Not Found');
    const out: Array<Record<string, unknown>> = [];
    for (const [childName, child] of [...children.entries()].sort()) {
      if (child.mode === 'dir') {
        // Find the tree oid for this directory.
        const dirTree = findTreeOid(repo, treeOid, `${path}/${childName}`);
        out.push({ type: 'dir', name: childName, path: `${path}/${childName}`, sha: dirTree ?? '' });
      } else {
        const data = (repo.objects.get(child.oid) as GitObject).data;
        out.push({ type: 'file', name: childName, path: `${path}/${childName}`, sha: child.oid, size: data.length });
      }
    }
    return sendJson(res, 200, out);
  }

  return sendError(res, 404, 'Not Found');
}

function findTreeOid(repo: Repo, rootTree: string, path: string): string | null {
  const parts = path.split('/').filter((p) => p !== '');
  let current = rootTree;
  for (const part of parts) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === part);
    if (!entry) return null;
    current = entry.oid;
  }
  return current;
}

// ---------------------------------------------------------------- GraphQL

// A small parser and executor for the documents gh and github-mcp-server
// send: queries, mutations, variables, aliases, inline enums, inline input
// objects, fragments, operation names, null variables, and __type probes.

type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };

interface GqlSelection {
  kind: 'field' | 'fragmentSpread' | 'inlineFragment';
  alias?: string;
  name?: string;
  args?: Array<{ name: string; value: GqlValue }>;
  selections?: GqlSelection[];
  typeCondition?: string;
  fragmentName?: string;
}

interface GqlOperation {
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  variables: Array<{ name: string; defaultValue?: GqlValue }>;
  selections: GqlSelection[];
}

interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, { typeCondition: string; selections: GqlSelection[] }>;
}

function gqlTokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < source.length && source[i] !== '\n') i += 1; continue; }
    if (c === '.' && source.slice(i, i + 3) === '...') { tokens.push('...'); i += 3; continue; }
    if ('{}()[]:!=$@&|'.includes(c)) { tokens.push(c); i += 1; continue; }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          if (esc === 'u' && j + 5 < source.length) {
            out += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' }[esc] ?? esc;
            j += 2;
          }
        } else {
          out += source[j] as string;
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i;
      while (j < source.length && /[_A-Za-z0-9]/.test(source[j] as string)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    throw new Error(`unexpected character in GraphQL document: ${c}`);
  }
  return tokens;
}

class GqlParser {
  private tokens: string[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = gqlTokenize(source);
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const t = this.tokens[this.pos];
    this.pos += 1;
    return t as string;
  }

  private expect(tok: string): void {
    const t = this.next();
    if (t !== tok) throw new Error(`expected ${tok} in GraphQL document, got ${t}`);
  }

  parseDocument(): GqlDocument {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, { typeCondition: string; selections: GqlSelection[] }>();
    while (this.pos < this.tokens.length) {
      const tok = this.peek();
      if (tok === 'query' || tok === 'mutation' || tok === 'subscription') {
        operations.push(this.parseOperation());
      } else if (tok === '{') {
        operations.push({ operation: 'query', variables: [], selections: this.parseSelectionSet() });
      } else if (tok === 'fragment') {
        this.next();
        const name = this.next();
        this.expect('on');
        const typeCondition = this.next();
        const selections = this.parseSelectionSet();
        fragments.set(name, { typeCondition, selections });
      } else {
        throw new Error(`unexpected token in GraphQL document: ${tok}`);
      }
    }
    return { operations, fragments };
  }

  private parseOperation(): GqlOperation {
    const operation = this.next() as 'query' | 'mutation' | 'subscription';
    let name: string | undefined;
    if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{') name = this.next();
    const variables: Array<{ name: string; defaultValue?: GqlValue }> = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        this.expect('$');
        const varName = this.next();
        this.expect(':');
        // Skip the type (a name, possibly wrapped in [] and !).
        while (this.peek() !== undefined && this.peek() !== '=' && this.peek() !== ')' && this.peek() !== '$') this.next();
        let defaultValue: GqlValue | undefined;
        if (this.peek() === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variables.push(defaultValue !== undefined ? { name: varName, defaultValue } : { name: varName });
      }
      this.expect(')');
    }
    const selections = this.parseSelectionSet();
    return { operation, name, variables, selections };
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const selections: GqlSelection[] = [];
    while (this.peek() !== '}') {
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  private parseSelection(): GqlSelection {
    if (this.peek() === '...') {
      this.next();
      const tok = this.peek();
      if (tok === 'on') {
        this.next();
        const typeCondition = this.next();
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (tok === '{') {
        this.skipDirectives();
        return { kind: 'inlineFragment', selections: this.parseSelectionSet() };
      }
      const fragmentName = this.next();
      this.skipDirectives();
      return { kind: 'fragmentSpread', fragmentName };
    }
    let name = this.next();
    let alias: string | undefined;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: Array<{ name: string; value: GqlValue }> = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expect(')');
    }
    this.skipDirectives();
    let selections: GqlSelection[] | undefined;
    if (this.peek() === '{') selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }

  private skipDirectives(): void {
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t === '(' || t === '[' || t === '{') depth += 1;
          if (t === ')' || t === ']' || t === '}') depth -= 1;
        }
      }
    }
  }

  private parseValue(): GqlValue {
    const tok = this.next();
    if (tok === '$') return { kind: 'variable', name: this.next() };
    if (tok === '[') {
      const values: GqlValue[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (tok === '{') {
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (tok === 'true') return { kind: 'boolean', value: true };
    if (tok === 'false') return { kind: 'boolean', value: false };
    if (tok === 'null') return { kind: 'null' };
    if (tok.startsWith('"')) return { kind: 'string', value: JSON.parse(tok) as string };
    if (/^-?\d+$/.test(tok)) return { kind: 'int', value: parseInt(tok, 10) };
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(tok)) return { kind: 'float', value: parseFloat(tok) };
    return { kind: 'enum', value: tok };
  }
}

function gqlValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable': return variables[value.name] ?? null;
    case 'int': case 'float': case 'string': case 'boolean': return value.value;
    case 'null': return null;
    case 'enum': return value.value;
    case 'list': return value.values.map((v) => gqlValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of value.fields) out[f.name] = gqlValue(f.value, variables);
      return out;
    }
  }
}

function gqlArgs(sel: GqlSelection, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of sel.args ?? []) out[a.name] = gqlValue(a.value, variables);
  return out;
}

// --- GraphQL type metadata (for __type introspection) ---

const GQL_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'url', 'createdAt', 'updatedAt'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'url', 'createdAt', 'updatedAt'],
  User: ['id', 'login', 'name', 'email'],
  BranchRef: ['name', 'prefix', 'target'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount', 'edges'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount', 'edges'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueComment: ['id', 'body', 'createdAt', 'updatedAt', 'author'],
  IssueCommentEdge: ['node', 'cursor'],
  ChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  FileConnection: ['nodes', 'pageInfo', 'totalCount'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
};

const GQL_ENUMS: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'ORGANIZATION', 'PROJECT', 'PULL_REQUEST', 'TOPIC'],
};

// --- GraphQL node builders ---

type GqlNode = Record<string, unknown> & { __typename: string };

function viewerNode(): GqlNode {
  return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL };
}

function repoNode(repo: Repo): GqlNode {
  return {
    __typename: 'Repository',
    repo,
    id: globalId('Repository', `${repo.owner}/${repo.name}`),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: viewerNode(),
    description: repo.description,
    isPrivate: repo.isPrivate,
  };
}

function issueNode(repo: Repo, issue: Issue): GqlNode {
  return {
    __typename: 'Issue',
    repo,
    issue,
    id: globalId('Issue', `${repo.owner}/${repo.name}/${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    url: `https://github.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    createdAt: isoFromSeq(issue.seq),
    updatedAt: isoFromSeq(issue.seq),
  };
}

function pullNode(repo: Repo, pull: Pull): GqlNode {
  return {
    __typename: 'PullRequest',
    repo,
    pull,
    id: globalId('PullRequest', `${repo.owner}/${repo.name}/${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    url: `https://github.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    createdAt: isoFromSeq(pull.seq),
    updatedAt: isoFromSeq(pull.seq),
  };
}

function issueCursor(issue: Issue): string {
  return b64encode(Buffer.from(`issue:${issue.number}`, 'utf8'));
}

function cursorToNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = b64decode(cursor).toString('utf8');
    const m = text.match(/^issue:(\d+)$/);
    return m ? parseInt(m[1] as string, 10) : null;
  } catch {
    return null;
  }
}

interface GqlCtx {
  errors: Array<{ message: string }>;
  variables: Record<string, unknown>;
  doc: GqlDocument;
}

function resolveSelections(node: unknown, typeName: string, selections: GqlSelection[], ctx: GqlCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragmentSpread') {
      const frag = ctx.doc.fragments.get(sel.fragmentName as string);
      if (!frag) continue;
      if (frag.typeCondition !== typeName) continue;
      Object.assign(out, resolveSelections(node, typeName, frag.selections, ctx));
      continue;
    }
    if (sel.kind === 'inlineFragment') {
      if (sel.typeCondition !== undefined && sel.typeCondition !== typeName) continue;
      Object.assign(out, resolveSelections(node, typeName, sel.selections ?? [], ctx));
      continue;
    }
    const fieldName = sel.name as string;
    const key = sel.alias ?? fieldName;
    const value = resolveField(node, typeName, sel, ctx);
    out[key] = value;
  }
  return out;
}

function resolveField(node: unknown, typeName: string, sel: GqlSelection, ctx: GqlCtx): unknown {
  const fieldName = sel.name as string;
  const args = gqlArgs(sel, ctx.variables);
  const record = node as GqlNode | null;
  // __type / __schema are available on every type.
  if (fieldName === '__type') {
    const name = String(args.name ?? '');
    const fields = GQL_FIELDS[name];
    const enumValues = GQL_ENUMS[name];
    const typeNode: GqlNode = {
      __typename: '__Type',
      name,
      kind: enumValues !== undefined ? 'ENUM' : 'OBJECT',
      description: '',
      fields: fields !== undefined ? fields.map((f) => ({ __typename: '__Field', name: f, description: '' })) : [],
      enumValues: enumValues !== undefined ? enumValues.map((v) => ({ __typename: '__EnumValue', name: v })) : [],
    };
    return sel.selections ? resolveSelections(typeNode, '__Type', sel.selections, ctx) : typeNode;
  }
  if (fieldName === '__schema') {
    const typeNode: GqlNode = {
      __typename: '__Schema',
      queryType: { __typename: '__Type', name: 'Query', kind: 'OBJECT' },
      mutationType: { __typename: '__Type', name: 'Mutation', kind: 'OBJECT' },
      subscriptionType: null,
      types: [...Object.keys(GQL_FIELDS), ...Object.keys(GQL_ENUMS)].map((n) => ({ __typename: '__Type', name: n, kind: GQL_ENUMS[n] !== undefined ? 'ENUM' : 'OBJECT' })),
    };
    return sel.selections ? resolveSelections(typeNode, '__Schema', sel.selections, ctx) : typeNode;
  }
  if (record === null || typeof record !== 'object') {
    ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}".` });
    return null;
  }
  const resolver = GQL_RESOLVERS[typeName]?.[fieldName];
  if (resolver === undefined) {
    ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}".` });
    return null;
  }
  let value: unknown;
  try {
    value = resolver(record, args, ctx);
  } catch (e) {
    ctx.errors.push({ message: e instanceof Error ? e.message : String(e) });
    return null;
  }
  if (value === undefined) return null;
  if (sel.selections === undefined) return value;
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item !== null && typeof item === 'object' && '__typename' in item) {
        return resolveSelections(item, (item as GqlNode).__typename, sel.selections as GqlSelection[], ctx);
      }
      return item;
    });
  }
  if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
    return resolveSelections(value, (value as GqlNode).__typename, sel.selections, ctx);
  }
  return value;
}

const GQL_RESOLVERS: Record<string, Record<string, (node: GqlNode, args: Record<string, unknown>, ctx: GqlCtx) => unknown>> = {
  Query: {
    viewer: () => viewerNode(),
    repository: (_node, args) => {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      const repo = getRepo(owner, name);
      return repo === null ? null : repoNode(repo);
    },
    node: (_node, args) => {
      const decoded = decodeGlobalId(args.id);
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const [owner, name] = decoded.key.split('/');
        const repo = getRepo(owner as string, name as string);
        return repo === null ? null : repoNode(repo);
      }
      if (decoded.kind === 'Issue') {
        const [owner, name, num] = decoded.key.split('/');
        const repo = getRepo(owner as string, name as string);
        const issue = repo?.issues.get(parseInt(num as string, 10));
        return repo && issue ? issueNode(repo, issue) : null;
      }
      if (decoded.kind === 'PullRequest') {
        const [owner, name, num] = decoded.key.split('/');
        const repo = getRepo(owner as string, name as string);
        const pull = repo?.pulls.get(parseInt(num as string, 10));
        return repo && pull ? pullNode(repo, pull) : null;
      }
      if (decoded.kind === 'User') return viewerNode();
      return null;
    },
  },
  Repository: {
    id: (n) => n.id,
    databaseId: (n) => n.databaseId,
    name: (n) => n.name,
    nameWithOwner: (n) => n.nameWithOwner,
    owner: (n) => n.owner,
    description: (n) => n.description,
    isPrivate: (n) => n.isPrivate,
    url: (n) => `https://github.invalid/${String(n.nameWithOwner)}`,
    createdAt: (n) => isoFromSeq((n.repo as Repo).seq),
    updatedAt: (n) => isoFromSeq((n.repo as Repo).seq),
    defaultBranchRef: (n) => {
      const repo = n.repo as Repo;
      const tip = refTip(repo, DEFAULT_BRANCH);
      if (tip === null) return null;
      return { __typename: 'BranchRef', name: DEFAULT_BRANCH, prefix: 'refs/heads/', target: { __typename: 'Commit', oid: tip } };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (n, args) => {
      const repo = n.repo as Repo;
      const issue = repo.issues.get(Number(args.number));
      return issue === undefined ? null : issueNode(repo, issue);
    },
    issues: (n, args) => {
      const repo = n.repo as Repo;
      let list = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states !== null) {
        const wanted = new Set(states.map((s) => String(s).toLowerCase()));
        list = list.filter((i) => wanted.has(i.state));
      }
      const orderBy = recordOf(args.orderBy);
      const direction = orderBy && typeof orderBy.direction === 'string' ? String(orderBy.direction) : 'DESC';
      const field = orderBy && typeof orderBy.field === 'string' ? String(orderBy.field) : 'CREATED_AT';
      list.sort((a, b) => {
        const key = field === 'COMMENTS' ? (x: Issue) => x.comments.length : (x: Issue) => x.seq;
        const diff = key(a) - key(b);
        if (diff !== 0) return direction === 'ASC' ? diff : -diff;
        return direction === 'ASC' ? a.number - b.number : b.number - a.number;
      });
      const afterNum = cursorToNumber(args.after);
      if (afterNum !== null) {
        const idx = list.findIndex((i) => i.number === afterNum);
        if (idx >= 0) list = list.slice(idx + 1);
      }
      const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : list.length;
      const page = list.slice(0, first);
      const hasNextPage = list.length > first;
      return {
        __typename: 'IssueConnection',
        nodes: page.map((i) => issueNode(repo, i)),
        totalCount: list.length,
        pageInfo: {
          __typename: 'PageInfo',
          hasNextPage,
          hasPreviousPage: false,
          startCursor: page.length > 0 ? issueCursor(page[0] as Issue) : null,
          endCursor: page.length > 0 ? issueCursor(page[page.length - 1] as Issue) : null,
        },
      };
    },
    pullRequests: (n, args) => {
      const repo = n.repo as Repo;
      let list = [...repo.pulls.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states !== null) {
        const wanted = new Set(states.map((s) => String(s).toUpperCase()));
        list = list.filter((p) => wanted.has(p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED'));
      }
      list.sort((a, b) => b.seq - a.seq);
      const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : list.length;
      const page = list.slice(0, first);
      return {
        __typename: 'PullRequestConnection',
        nodes: page.map((p) => pullNode(repo, p)),
        totalCount: list.length,
        pageInfo: {
          __typename: 'PageInfo',
          hasNextPage: list.length > first,
          hasPreviousPage: false,
          startCursor: null,
          endCursor: null,
        },
      };
    },
    pullRequest: (n, args) => {
      const repo = n.repo as Repo;
      const pull = repo.pulls.get(Number(args.number));
      return pull === undefined ? null : pullNode(repo, pull);
    },
  },
  User: {
    id: (n) => n.id ?? VIEWER_ID,
    login: (n) => n.login,
    name: (n) => n.name ?? VIEWER_NAME,
    email: (n) => n.email ?? VIEWER_EMAIL,
  },
  BranchRef: {
    name: (n) => n.name,
    prefix: (n) => n.prefix ?? 'refs/heads/',
    target: (n) => n.target ?? null,
  },
  Issue: {
    id: (n) => n.id,
    number: (n) => n.number,
    title: (n) => n.title,
    state: (n) => n.state,
    body: (n) => n.body,
    url: (n) => n.url,
    createdAt: (n) => n.createdAt,
    updatedAt: (n) => n.updatedAt,
    author: () => viewerNode(),
    labels: (n) => {
      const repo = n.repo as Repo;
      const issue = n.issue as Issue;
      return {
        __typename: 'LabelConnection',
        nodes: issue.labels.map((name) => ({ __typename: 'Label', name, color: repo.labels.get(name)?.color ?? 'ededed' })),
        totalCount: issue.labels.length,
      };
    },
    comments: (n) => {
      const issue = n.issue as Issue;
      return {
        __typename: 'IssueCommentConnection',
        nodes: issue.comments.map((c) => ({ __typename: 'IssueComment', id: globalId('IssueComment', `${(n.repo as Repo).owner}/${(n.repo as Repo).name}/${issue.number}/${c.id}`), body: c.body, createdAt: isoFromSeq(c.seq), updatedAt: isoFromSeq(c.seq) })),
        totalCount: issue.comments.length,
      };
    },
  },
  Label: {
    name: (n) => n.name,
    color: (n) => n.color,
  },
  LabelConnection: {
    nodes: (n) => n.nodes,
    totalCount: (n) => n.totalCount,
  },
  IssueCommentConnection: {
    nodes: (n) => n.nodes,
    totalCount: (n) => n.totalCount,
  },
  IssueConnection: {
    nodes: (n) => n.nodes,
    totalCount: (n) => n.totalCount,
    pageInfo: (n) => n.pageInfo,
    edges: (n) => (n.nodes as GqlNode[]).map((node) => ({ __typename: 'IssueEdge', node, cursor: issueCursor((node as GqlNode).issue as Issue) })),
  },
  PullRequestConnection: {
    nodes: (n) => n.nodes,
    totalCount: (n) => n.totalCount,
    pageInfo: (n) => n.pageInfo,
    edges: (n) => (n.nodes as GqlNode[]).map((node) => ({ __typename: 'PullRequestEdge', node, cursor: b64encode(Buffer.from(`pr:${(node as GqlNode).number}`, 'utf8')) })),
  },
  IssueEdge: {
    node: (n) => n.node,
    cursor: (n) => n.cursor,
  },
  PullRequestEdge: {
    node: (n) => n.node,
    cursor: (n) => n.cursor,
  },
  PageInfo: {
    hasNextPage: (n) => n.hasNextPage,
    hasPreviousPage: (n) => n.hasPreviousPage,
    startCursor: (n) => n.startCursor,
    endCursor: (n) => n.endCursor,
  },
  PullRequest: {
    id: (n) => n.id,
    number: (n) => n.number,
    title: (n) => n.title,
    body: (n) => n.body,
    headRefName: (n) => n.headRefName,
    baseRefName: (n) => n.baseRefName,
    state: (n) => n.state,
    merged: (n) => n.merged,
    mergeable: (n) => {
      const repo = n.repo as Repo;
      const pull = n.pull as Pull;
      if (pull.state !== 'open') return 'UNKNOWN';
      return prConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    },
    url: (n) => n.url,
    createdAt: (n) => n.createdAt,
    updatedAt: (n) => n.updatedAt,
    files: (n, args) => {
      const repo = n.repo as Repo;
      const pull = n.pull as Pull;
      const head = commitAt(repo, pull.headRef);
      const base = commitAt(repo, pull.baseRef);
      if (!head || !base) return { __typename: 'FileConnection', nodes: [], totalCount: 0, pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } };
      const mb = mergeBase(repo.objects, head.oid, base.oid);
      const baseTree = mb !== null ? parseCommit((repo.objects.get(mb) as GitObject).data).tree : base.info.tree;
      const changes = diffTrees(repo, baseTree, head.info.tree);
      const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : changes.length;
      const page = changes.slice(0, first);
      return {
        __typename: 'FileConnection',
        nodes: page.map((c) => ({ __typename: 'ChangedFile', path: c.filename, additions: c.additions, deletions: c.deletions, changeType: c.status === 'added' ? 'ADDED' : c.status === 'removed' ? 'REMOVED' : 'MODIFIED' })),
        totalCount: changes.length,
        pageInfo: { __typename: 'PageInfo', hasNextPage: changes.length > first, hasPreviousPage: false, startCursor: null, endCursor: null },
      };
    },
  },
  FileConnection: {
    nodes: (n) => n.nodes,
    totalCount: (n) => n.totalCount,
    pageInfo: (n) => n.pageInfo,
  },
  ChangedFile: {
    path: (n) => n.path,
    additions: (n) => n.additions,
    deletions: (n) => n.deletions,
    changeType: (n) => n.changeType,
  },
  IssueComment: {
    id: (n) => n.id,
    body: (n) => n.body,
    createdAt: (n) => n.createdAt,
    updatedAt: (n) => n.updatedAt,
    author: () => viewerNode(),
  },
  IssueCommentEdge: {
    node: (n) => n.node,
    cursor: (n) => n.cursor,
  },
  __Type: {
    name: (n) => n.name,
    kind: (n) => n.kind,
    description: (n) => n.description ?? '',
    fields: (n) => n.fields ?? [],
    enumValues: (n) => n.enumValues ?? [],
  },
  CreateIssuePayload: {
    issue: (n) => n.issue,
    clientMutationId: (n) => n.clientMutationId ?? null,
  },
  CloseIssuePayload: {
    issue: (n) => n.issue,
    clientMutationId: (n) => n.clientMutationId ?? null,
  },
  CreatePullRequestPayload: {
    pullRequest: (n) => n.pullRequest,
    clientMutationId: (n) => n.clientMutationId ?? null,
  },
  MergePullRequestPayload: {
    pullRequest: (n) => n.pullRequest,
    clientMutationId: (n) => n.clientMutationId ?? null,
  },
  AddCommentPayload: {
    commentEdge: (n) => n.commentEdge,
    clientMutationId: (n) => n.clientMutationId ?? null,
  },
  __Field: {
    name: (n) => n.name,
    description: (n) => n.description ?? '',
  },
  __EnumValue: {
    name: (n) => n.name,
  },
  __Schema: {
    queryType: (n) => n.queryType,
    mutationType: (n) => n.mutationType,
    subscriptionType: (n) => n.subscriptionType,
    types: (n) => n.types,
  },
  Mutation: {
    createIssue: (_n, args) => {
      const input = recordOf(args.input) ?? {};
      const decoded = decodeGlobalId(input.repositoryId);
      if (!decoded || decoded.kind !== 'Repository') throw new Error('createIssue: unknown repositoryId');
      const [owner, name] = decoded.key.split('/');
      const repo = getRepo(owner as string, name as string);
      if (!repo) throw new Error('createIssue: repository not found');
      const { issue } = createIssueInRepo(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      if (!issue) throw new Error('createIssue: failed');
      return { __typename: 'CreateIssuePayload', issue: issueNode(repo, issue), clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null };
    },
    closeIssue: (_n, args) => {
      const input = recordOf(args.input) ?? {};
      const decoded = decodeGlobalId(input.issueId);
      if (!decoded || decoded.kind !== 'Issue') throw new Error('closeIssue: unknown issueId');
      const [owner, name, num] = decoded.key.split('/');
      const repo = getRepo(owner as string, name as string);
      const issue = repo?.issues.get(parseInt(num as string, 10));
      if (!repo || !issue) throw new Error('closeIssue: issue not found');
      issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: issueNode(repo, issue), clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null };
    },
    createPullRequest: (_n, args) => {
      const input = recordOf(args.input) ?? {};
      const decoded = decodeGlobalId(input.repositoryId);
      if (!decoded || decoded.kind !== 'Repository') throw new Error('createPullRequest: unknown repositoryId');
      const [owner, name] = decoded.key.split('/');
      const repo = getRepo(owner as string, name as string);
      if (!repo) throw new Error('createPullRequest: repository not found');
      const { pull, error } = createPullInRepo(repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
      if (!pull) throw new Error(`createPullRequest: ${error ?? 'failed'}`);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pull), clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null };
    },
    mergePullRequest: (_n, args) => {
      const input = recordOf(args.input) ?? {};
      const decoded = decodeGlobalId(input.pullRequestId);
      if (!decoded || decoded.kind !== 'PullRequest') throw new Error('mergePullRequest: unknown pullRequestId');
      const [owner, name, num] = decoded.key.split('/');
      const repo = getRepo(owner as string, name as string);
      const pull = repo?.pulls.get(parseInt(num as string, 10));
      if (!repo || !pull) throw new Error('mergePullRequest: pull request not found');
      const method = typeof input.mergeMethod === 'string' ? String(input.mergeMethod) : 'SQUASH';
      if (method !== 'SQUASH' && method !== 'MERGE' && method !== 'REBASE') throw new Error('mergePullRequest: invalid mergeMethod');
      if (pull.state !== 'open') throw new Error('mergePullRequest: pull request is not open');
      const sha = squashMerge(repo, pull);
      if (sha === null) throw new Error('mergePullRequest: merge conflict');
      return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(repo, pull), clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null };
    },
    addComment: (_n, args) => {
      const input = recordOf(args.input) ?? {};
      const decoded = decodeGlobalId(input.subjectId);
      if (!decoded || decoded.kind !== 'Issue') throw new Error('addComment: unknown subjectId');
      const [owner, name, num] = decoded.key.split('/');
      const repo = getRepo(owner as string, name as string);
      const issue = repo?.issues.get(parseInt(num as string, 10));
      if (!repo || !issue) throw new Error('addComment: issue not found');
      const comment: Comment = { id: repo.nextCommentId, body: String(input.body ?? ''), seq: nextSeq() };
      repo.nextCommentId += 1;
      issue.comments.push(comment);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: { __typename: 'IssueComment', id: globalId('IssueComment', `${repo.owner}/${repo.name}/${issue.number}/${comment.id}`), body: comment.body, createdAt: isoFromSeq(comment.seq), updatedAt: isoFromSeq(comment.seq) },
          cursor: b64encode(Buffer.from(`comment:${comment.id}`, 'utf8')),
        },
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      };
    },
  },
};

function executeGraphQL(doc: GqlDocument, variables: Record<string, unknown>, operationName?: string): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  const op = operationName !== undefined
    ? doc.operations.find((o) => o.name === operationName) ?? doc.operations[0]
    : doc.operations[0];
  if (op === undefined) return { data: null, errors: [{ message: 'no operation in document' }] };
  const mergedVars: Record<string, unknown> = { ...variables };
  for (const v of op.variables) {
    if (mergedVars[v.name] === undefined && v.defaultValue !== undefined) {
      mergedVars[v.name] = gqlValue(v.defaultValue, mergedVars);
    }
  }
  const ctx: GqlCtx = { errors: [], variables: mergedVars, doc };
  const rootType = op.operation === 'mutation' ? 'Mutation' : 'Query';
  const rootNode: GqlNode = { __typename: rootType };
  const data = resolveSelections(rootNode, rootType, op.selections, ctx);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

function handleGraphQL(ctx: ReqCtx, res: http.ServerResponse): void {
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) return sendError(res, 400, 'malformed JSON body');
  const runOne = (body: unknown): Record<string, unknown> => {
    const record = recordOf(body);
    if (!record || typeof record.query !== 'string') return { data: null, errors: [{ message: 'query is required' }] };
    let doc: GqlDocument;
    try {
      doc = new GqlParser(record.query).parseDocument();
    } catch (e) {
      return { data: null, errors: [{ message: e instanceof Error ? e.message : 'failed to parse query' }] };
    }
    const variables = recordOf(record.variables) ?? {};
    const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;
    return executeGraphQL(doc, variables, operationName);
  };
  if (Array.isArray(parsed.value)) {
    return sendJson(res, 200, parsed.value.map(runOne));
  }
  return sendJson(res, 200, runOne(parsed.value));
}

// ---------------------------------------------------------------- MCP

const MCP_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// A fixed tool list: two tools/list calls answer the same list byte for byte.
const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
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
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name owner/repo' },
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
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name owner/repo' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
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
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name owner/repo' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name owner/repo' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name owner/repo' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name owner/repo' },
        issue_number: { type: 'integer', description: 'Issue number' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name owner/repo' },
        state: { type: 'string', description: 'Pull request state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
];

/** Resolve {owner, repo} from tool arguments, accepting full_name / repository spellings. */
function mcpRepoRef(args: Record<string, unknown>): { owner: string; repo: string } | null {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  const full = typeof args.full_name === 'string' ? args.full_name : typeof args.repository === 'string' ? args.repository : '';
  if ((owner === '' || repo === '') && full !== '' && full.includes('/')) {
    const [o, r] = full.split('/');
    if (owner === '') owner = o as string;
    if (repo === '') repo = r as string;
  }
  if (repo !== '' && repo.includes('/') && owner === '') {
    const [o, r] = repo.split('/');
    owner = o as string;
    repo = r as string;
  }
  if (owner === '' || repo === '') return null;
  return { owner, repo };
}

function mcpInt(args: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
    if (typeof v === 'string' && /^-?\d+$/.test(v)) return parseInt(v, 10);
  }
  return null;
}

function mcpToolResult(result: unknown): Record<string, unknown> {
  const text = jsonStringify(result);
  return { content: [{ type: 'text', text }], structuredContent: result, isError: false };
}

function mcpToolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callMcpTool(name: string, args: Record<string, unknown>): { result: Record<string, unknown> } | { error: { code: number; message: string } } {
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (!tool) return { error: { code: -32602, message: `unknown tool: ${name}` } };
  const missing: string[] = [];
  for (const req of (tool.inputSchema.required as string[] | undefined) ?? []) {
    if (args[req] === undefined || args[req] === null || args[req] === '') missing.push(req);
  }
  // full_name can stand in for owner+repo.
  const hasFullName = typeof args.full_name === 'string' && args.full_name !== '' || typeof args.repository === 'string' && args.repository !== '';
  const stillMissing = missing.filter((m) => !(hasFullName && (m === 'owner' || m === 'repo')));
  if (stillMissing.length > 0) {
    return { error: { code: -32602, message: `missing required argument(s): ${stillMissing.join(', ')}` } };
  }
  const ref = mcpRepoRef(args);
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name ?? '');
      if (repoName === '') return { error: { code: -32602, message: 'missing required argument: name' } };
      if (repos.has(repoName)) return { result: mcpToolError('name already exists on this account') };
      const repo = createRepo(repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
      return { result: mcpToolResult(repoJson(repo)) };
    }
    case 'get_repo': {
      if (!ref) return { error: { code: -32602, message: 'missing required argument: owner/repo' } };
      const repo = getRepo(ref.owner, ref.repo);
      if (!repo) return { result: mcpToolError('Not Found') };
      return { result: mcpToolResult(repoJson(repo)) };
    }
    case 'create_issue': {
      if (!ref) return { error: { code: -32602, message: 'missing required argument: owner/repo' } };
      const repo = getRepo(ref.owner, ref.repo);
      if (!repo) return { result: mcpToolError('Not Found') };
      const title = typeof args.title === 'string' ? args.title : '';
      if (title === '') return { error: { code: -32602, message: 'missing required argument: title' } };
      const { issue } = createIssueInRepo(repo, title, typeof args.body === 'string' ? args.body : '', []);
      if (!issue) return { result: mcpToolError('failed to create issue') };
      return { result: mcpToolResult(issueJson(repo, issue)) };
    }
    case 'list_issues': {
      if (!ref) return { error: { code: -32602, message: 'missing required argument: owner/repo' } };
      const repo = getRepo(ref.owner, ref.repo);
      if (!repo) return { result: mcpToolError('Not Found') };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => b.seq - a.seq);
      return { result: mcpToolResult(list.map((i) => issueJson(repo, i))) };
    }
    case 'create_pull_request': {
      if (!ref) return { error: { code: -32602, message: 'missing required argument: owner/repo' } };
      const repo = getRepo(ref.owner, ref.repo);
      if (!repo) return { result: mcpToolError('Not Found') };
      const head = typeof args.head === 'string' ? args.head : typeof args.head_branch === 'string' ? args.head_branch : '';
      const base = typeof args.base === 'string' ? args.base : typeof args.base_branch === 'string' ? args.base_branch : DEFAULT_BRANCH;
      const { pull, error } = createPullInRepo(repo, typeof args.title === 'string' ? args.title : '', typeof args.body === 'string' ? args.body : '', head, base);
      if (!pull) return { result: mcpToolError(error ?? 'failed to create pull request') };
      return { result: mcpToolResult(pullJson(repo, pull)) };
    }
    case 'merge_pull_request': {
      if (!ref) return { error: { code: -32602, message: 'missing required argument: owner/repo' } };
      const repo = getRepo(ref.owner, ref.repo);
      if (!repo) return { result: mcpToolError('Not Found') };
      const number = mcpInt(args, ['pull_number', 'number', 'pull_request_number']);
      if (number === null) return { error: { code: -32602, message: 'missing required argument: pull_number' } };
      const pull = repo.pulls.get(number);
      if (!pull) return { result: mcpToolError('Not Found') };
      if (pull.state !== 'open') return { result: mcpToolError('Pull request is not open') };
      const sha = squashMerge(repo, pull);
      if (sha === null) return { result: mcpToolError('Merge conflict') };
      return { result: mcpToolResult({ sha, merged: true, number: pull.number, state: 'closed' }) };
    }
    case 'get_issue': {
      if (!ref) return { error: { code: -32602, message: 'missing required argument: owner/repo' } };
      const repo = getRepo(ref.owner, ref.repo);
      if (!repo) return { result: mcpToolError('Not Found') };
      const number = mcpInt(args, ['issue_number', 'number']);
      if (number === null) return { error: { code: -32602, message: 'missing required argument: issue_number' } };
      const issue = repo.issues.get(number);
      if (!issue) return { result: mcpToolError('Not Found') };
      return { result: mcpToolResult(issueJson(repo, issue)) };
    }
    case 'list_pull_requests': {
      if (!ref) return { error: { code: -32602, message: 'missing required argument: owner/repo' } };
      const repo = getRepo(ref.owner, ref.repo);
      if (!repo) return { result: mcpToolError('Not Found') };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.pulls.values()];
      if (state !== 'all') list = list.filter((p) => p.state === state);
      list.sort((a, b) => b.seq - a.seq);
      return { result: mcpToolResult(list.map((p) => pullJson(repo, p))) };
    }
    default:
      return { error: { code: -32602, message: `unknown tool: ${name}` } };
  }
}

function handleMcp(ctx: ReqCtx, res: http.ServerResponse): void {
  const sessionId = typeof ctx.headers['mcp-session-id'] === 'string' ? ctx.headers['mcp-session-id'] : undefined;
  const replyHeaders: Record<string, string> = { 'content-type': 'application/json' };
  if (sessionId !== undefined) replyHeaders['mcp-session-id'] = sessionId;

  let body: unknown;
  try {
    body = ctx.body.length === 0 ? null : JSON.parse(ctx.body.toString('utf8'));
  } catch {
    res.writeHead(400, replyHeaders);
    res.end(jsonStringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    return;
  }
  const record = recordOf(body);
  if (!record || record.jsonrpc !== '2.0' || typeof record.method !== 'string') {
    res.writeHead(400, replyHeaders);
    res.end(jsonStringify({ jsonrpc: '2.0', id: recordOf(body)?.id ?? null, error: { code: -32600, message: 'Invalid Request' } }));
    return;
  }
  const id = record.id ?? null;
  const method = record.method as string;
  const params = recordOf(record.params) ?? {};
  const isNotification = id === null;

  const ok = (result: unknown): void => {
    if (isNotification) {
      res.writeHead(202, replyHeaders);
      res.end();
      return;
    }
    res.writeHead(200, replyHeaders);
    res.end(jsonStringify({ jsonrpc: '2.0', id, result }));
  };
  const fail = (code: number, message: string): void => {
    if (isNotification) {
      res.writeHead(202, replyHeaders);
      res.end();
      return;
    }
    res.writeHead(200, replyHeaders);
    res.end(jsonStringify({ jsonrpc: '2.0', id, error: { code, message } }));
  };

  if (method === 'server/discover') {
    return ok({
      supportedVersions: MCP_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const chosen = MCP_VERSIONS.includes(offered) ? offered : MCP_VERSIONS[1] as string;
    return ok({
      protocolVersion: chosen,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    res.writeHead(202, replyHeaders);
    res.end();
    return;
  }
  if (method === 'ping') return ok({});
  if (method === 'tools/list') {
    return ok({ tools: MCP_TOOLS });
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = recordOf(params.arguments) ?? {};
    const outcome = callMcpTool(toolName, args);
    if ('error' in outcome) return fail(outcome.error.code, outcome.error.message);
    return ok(outcome.result);
  }
  return fail(-32601, `Method not found: ${method}`);
}

// ---------------------------------------------------------------- server + boot

async function dispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readBody(req);
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  const ctx: ReqCtx = {
    method: req.method ?? 'GET',
    url,
    pathname: url.pathname,
    headers: req.headers,
    body,
    params: {},
  };
  try {
    if (ctx.pathname === '/healthz') {
      return sendJson(res, 200, { ok: true });
    }
    if (ctx.pathname === '/api/graphql' && ctx.method === 'POST') {
      if (!authorized(ctx)) return sendError(res, 401, 'Requires authentication');
      return handleGraphQL(ctx, res);
    }
    if (ctx.pathname === '/mcp' && ctx.method === 'POST') {
      if (!authorized(ctx)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(jsonStringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Requires authentication' } }));
        return;
      }
      return handleMcp(ctx, res);
    }
    if (ctx.pathname.startsWith('/api/v3')) {
      if (!authorized(ctx)) return sendError(res, 401, 'Requires authentication');
      return handleRest(ctx, res);
    }
    const gitMatch = ctx.pathname.match(/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
    if (gitMatch) {
      if (!authorized(ctx)) return sendError(res, 401, 'Requires authentication');
      const owner = decodeURIComponent(gitMatch[1] as string);
      const name = decodeURIComponent(gitMatch[2] as string);
      const action = gitMatch[3] as string;
      if (action === 'info/refs' && ctx.method === 'GET') {
        const service = ctx.url.searchParams.get('service') ?? '';
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return sendError(res, 400, 'service is required');
        return handleInfoRefs(ctx, res, owner, name, service);
      }
      if (action === 'git-upload-pack' && ctx.method === 'POST') return handleUploadPack(ctx, res, owner, name);
      if (action === 'git-receive-pack' && ctx.method === 'POST') return handleReceivePack(ctx, res, owner, name);
      return sendError(res, 404, 'Not Found');
    }
    return sendError(res, 404, 'Not Found');
  } catch (e) {
    if (!res.headersSent) sendError(res, 500, e instanceof Error ? e.message : 'internal error');
    else res.end();
  }
}

const server = http.createServer((req, res) => {
  dispatch(req, res).catch((e: unknown) => {
    if (!res.headersSent) sendError(res, 500, e instanceof Error ? e.message : 'internal error');
    else res.end();
  });
});

server.on('error', (e: Error) => {
  console.error(`server error: ${e.message}`);
  process.exit(1);
});

async function postJson(url: string, value: unknown, token: string): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token !== '' ? { authorization: `Bearer ${token}` } : {}) },
    body: jsonStringify(value),
  });
  return { status: response.status, text: await response.text() };
}

async function main(): Promise<void> {
  if (ENV_URL === '') {
    // Standalone mode (local development): serve on a fixed port, no suite.
    const port = parseInt(process.env.PORT ?? '18080', 10);
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    console.log(`${SERVER_NAME} listening on http://127.0.0.1:${port} (standalone mode, no MAKEFUN_ENV_URL)`);
    return;
  }
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
  const registered = await postJson(`${ENV_URL}/register`, { port }, TOKEN);
  if (registered.status !== 200 && registered.status !== 201) {
    console.error(`register failed: HTTP ${registered.status}: ${registered.text}`);
    process.exit(1);
  }
  // Long-poll /done until the suite finishes, then exit 0.
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      const response = await fetch(`${ENV_URL}/done`, {
        headers: TOKEN !== '' ? { authorization: `Bearer ${TOKEN}` } : {},
      });
      const text = await response.text();
      const parsed = JSON.parse(text) as { done?: boolean };
      if (parsed.done === true) break;
    } catch {
      // Transient env hiccup: keep polling.
    }
  }
  server.close();
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
