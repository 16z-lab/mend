// mend: the CLI SPEC.md specifies (sections 1-10). Node 22, standard library only.
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set and this hands over to runner.ts.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) { this.line = line; }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) { this.code = code; this.path = path; }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/* ---------------------------------------------------------------- line helpers */

function breakOf(t: string): string {
  const i = t.indexOf('\n');
  return i > 0 && t[i - 1] === '\r' ? '\r\n' : '\n';
}

interface Content { lines: string[]; final: boolean; br: string }

function toContent(text: string): Content {
  const br = breakOf(text);
  if (text === '') return { lines: [], final: false, br };
  const final = text.endsWith(br);
  const body = final ? text.slice(0, -br.length) : text;
  return { lines: body.split(br), final, br };
}

function fromContent(c: Content): string {
  if (c.lines.length === 0) return '';
  return c.lines.join(c.br) + (c.final ? c.br : '');
}

const wsHead = (s: string): string => {
  const m = /^[ \t]*/.exec(s)!;
  return m[0];
};

function eq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return a.replace(/[ \t]+$/, '') === b.replace(/[ \t]+$/, '');
  return a.replace(/^[ \t]+|[ \t]+$/g, '') === b.replace(/^[ \t]+|[ \t]+$/g, '');
}

function occurrences(hay: string[], needle: string[], tier: number): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (!eq(hay[i + j]!, needle[j]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0..2, or only 0 with --strict) at which O occurs at least once. */
function findTier(hay: string[], needle: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrences(hay, needle, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/* ---------------------------------------------------------------- tree */

class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { from: string; to: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch { v = null; }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/* ---------------------------------------------------------------- format detect */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ---------------------------------------------------------------- hunk model */

type BodyKind = 'ctx' | 'old' | 'new' | 'bs';

interface BodyLine { kind: BodyKind; text: string }

interface Hunk {
  a: number;
  body: BodyLine[];
  anchor: string | null;
  eof: boolean;
}

/** Apply one hunk to `c`, returning the new content. */
function applyHunk(c: Content, h: Hunk, d: number, strict: boolean, path: string): { content: Content; delta: number } {
  const O: string[] = [];
  const N: { ctx: boolean; text: string; oi: number }[] = [];
  for (const b of h.body) {
    if (b.kind === 'bs') continue;
    if (b.kind === 'ctx') { N.push({ ctx: true, text: b.text, oi: O.length }); O.push(b.text); }
    else if (b.kind === 'old') O.push(b.text);
    else N.push({ ctx: false, text: b.text, oi: -1 });
  }

  let pos: number;
  let tier = 0;
  if (O.length === 0) {
    pos = Math.min(h.a + d, c.lines.length);
  } else {
    const found = findTier(c.lines, O, strict);
    if (found === null) throw new Fail('no-match', path);
    tier = found.tier;
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    for (const p of found.occ) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    pos = best;
  }

  const F = O.length > 0 ? wsHead(c.lines[pos] ?? '') : '';
  const P = O.length > 0 ? wsHead(O[0]!) : '';

  const out: string[] = [];
  for (const n of N) {
    if (n.ctx) {
      out.push(c.lines[pos + n.oi] ?? n.text);
    } else if (tier === 2 && n.text !== '' && n.text.trim() !== '' && P !== '' && n.text.startsWith(P)) {
      out.push(F + n.text.slice(P.length));
    } else {
      out.push(n.text);
    }
  }
  const tail = c.lines.slice(pos + O.length);
  const lines = [...c.lines.slice(0, pos), ...out, ...tail];

  // trailing break handling
  const matchedToEnd = O.length > 0 ? pos + O.length === c.lines.length : pos === c.lines.length;
  let final = c.final;
  if (matchedToEnd) {
    const lastIdx = lastBodyIndex(h.body);
    const bsAfter = lastIdx >= 0 && h.body.slice(lastIdx + 1).some((b) => b.kind === 'bs');
    final = !bsAfter;
  }
  const delta = N.length - O.length;
  return { content: { lines, final, br: c.br }, delta };
}

function lastBodyIndex(body: BodyLine[]): number {
  for (let i = body.length - 1; i >= 0; i--) if (body[i]!.kind === 'ctx' || body[i]!.kind === 'new') return i;
  return -1;
}

/* ---------------------------------------------------------------- unified */

function pathOf(line: string, prefix: string): string | null {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.trim();
  if (s === '/dev/null') return null;
  if (s.startsWith(prefix)) s = s.slice(prefix.length);
  return s;
}

function parseUnified(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    let oldPath: string | null = null;
    let newPath: string | null = null;
    let newFile = false;
    let delFile = false;
    let renameFrom: string | null = null;
    let renameTo: string | null = null;
    let fromDiffGit = false;

    const l0 = lines[i]!;
    if (l0.startsWith('diff --git ')) {
      const rest = l0.slice('diff --git '.length);
      if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${i + 1}`);
      const sep = rest.indexOf(' b/', 2);
      if (sep < 0) throw new Exit2(`error: parse ${i + 1}`);
      oldPath = rest.slice(2, sep);
      newPath = rest.slice(sep + 3);
      fromDiffGit = true;
      i += 1;
    } else if (l0.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      oldPath = pathOf(l0, 'a/');
      newPath = pathOf(lines[i + 1]!, 'b/');
      i += 2;
    } else { i += 1; continue; }

    const hunks: Hunk[] = [];
    let sawHunk = false;
    while (i < n) {
      const l = lines[i]!;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        if (sawHunk) break;
        oldPath = pathOf(l, 'a/');
        newPath = pathOf(lines[i + 1]!, 'b/');
        i += 2;
        continue;
      }
      if (l.startsWith('@@')) {
        const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
        if (!m) throw new Exit2(`error: parse ${i + 1}`);
        sawHunk = true;
        const hunk: Hunk = { a: Number(m[1]), body: [], anchor: null, eof: false };
        i += 1;
        while (i < n) {
          const b = lines[i]!;
          if (b.startsWith('diff --git ')) break;
          if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
          if (b.startsWith(' ')) { hunk.body.push({ kind: 'ctx', text: b.slice(1) }); i += 1; continue; }
          if (b.startsWith('-')) { hunk.body.push({ kind: 'old', text: b.slice(1) }); i += 1; continue; }
          if (b.startsWith('+')) { hunk.body.push({ kind: 'new', text: b.slice(1) }); i += 1; continue; }
          if (b.startsWith('\\')) { hunk.body.push({ kind: 'bs', text: b }); i += 1; continue; }
          if (b === '') { hunk.body.push({ kind: 'ctx', text: '' }); i += 1; continue; }
          break;
        }
        while (hunk.body.length > 0) {
          const last = hunk.body[hunk.body.length - 1]!;
          if (last.kind === 'ctx' && last.text === '') hunk.body.pop();
          else break;
        }
        hunks.push(hunk);
        continue;
      }
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) { renameFrom = l.slice(12).trim(); i += 1; continue; }
      if (l.startsWith('rename to ')) { renameTo = l.slice(10).trim(); i += 1; continue; }
      if (l.startsWith('new file mode')) { newFile = true; i += 1; continue; }
      if (l.startsWith('deleted file mode')) { delFile = true; i += 1; continue; }
      if (!sawHunk) { i += 1; continue; }
      i += 1;
    }

    if (renameFrom !== null && renameTo !== null && (oldPath === null || !fromDiffGit || oldPath === renameFrom)) {
      if (renameFrom !== null) oldPath = renameFrom;
      if (renameTo !== null) newPath = renameTo;
    }

    const op = oldPath;
    const np = newPath;
    edits.push((tree) => {
      // creation
      if (newFile || op === null) {
        const target = np;
        if (target === null) throw new Fail('missing', '(none)');
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) !== null) throw new Fail('exists', target);
        const nl: string[] = [];
        let bsAfterLast = false;
        for (const h of hunks) {
          for (const b of h.body) {
            if (b.kind === 'new') { nl.push(b.text); bsAfterLast = false; }
            else if (b.kind === 'bs') bsAfterLast = true;
          }
        }
        tree.now.set(target, nl.length === 0 ? '' : nl.join('\n') + (bsAfterLast ? '' : '\n'));
        return;
      }
      // deletion
      if (delFile || np === null || op === '(none)') {
        if (!safe(op!)) throw new Fail('unsafe', op!);
        if (tree.get(op!) === null) throw new Fail('missing', op!);
        tree.now.set(op!, null);
        return;
      }
      // change or move
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      const isMove = op !== np;
      if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
      let content = toContent(before);
      let d = 0;
      for (const h of hunks) {
        const r = applyHunk(content, h, d, strict, op);
        content = r.content;
        d += r.delta;
      }
      const text = fromContent(content);
      if (isMove) {
        tree.now.set(op, null);
        tree.now.set(np, text);
        tree.moves.push({ from: op, to: np });
      } else {
        tree.now.set(op, text);
      }
    });
  }
  return edits;
}

/* ---------------------------------------------------------------- search/replace */

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  const n = lines.length;
  for (let i = 0; i < n; i++) {
    if (lines[i]!.replace(/[ \t]+$/, '') !== '<<<<<<< SEARCH') continue;
    const searchLine = i;
    // path: nearest non-blank line before, after previous REPLACE, not starting with ```
    let path: string | null = null;
    for (let k = i - 1; k >= 0; k--) {
      const t = lines[k]!;
      if (blank(t)) continue;
      const s = t.trim();
      if (s.startsWith('```')) continue;
      path = s;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    const target = path;
    const oldLines: string[] = [];
    let j = i + 1;
    let sawSep = false;
    for (; j < n; j++) {
      if (lines[j]!.replace(/[ \t]+$/, '') === '=======') { sawSep = true; j += 1; break; }
      if (lines[j]!.replace(/[ \t]+$/, '') === '>>>>>>> REPLACE') break;
      oldLines.push(lines[j]!);
    }
    if (!sawSep) throw new Exit2(`error: parse ${searchLine + 1}`);
    const newLines: string[] = [];
    for (; j < n; j++) {
      if (lines[j]!.replace(/[ \t]+$/, '') === '>>>>>>> REPLACE') break;
      newLines.push(lines[j]!);
    }
    if (j >= n) throw new Exit2(`error: parse ${searchLine + 1}`);
    const end = j;
    prevPath = target;
    i = end;

    edits.push((tree) => {
      if (!safe(target)) throw new Fail('unsafe', target);
      if (oldLines.length === 0) {
        if (tree.get(target) !== null) throw new Fail('exists', target);
        let text = newLines.join('\n');
        const bsAfter = false;
        if (newLines.length > 0) text += '\n';
        tree.now.set(target, text);
        return;
      }
      const before = tree.get(target);
      if (before === null) throw new Fail('missing', target);
      const c = toContent(before);
      const found = findTier(c.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', target);
      if (found.occ.length > 1) throw new Fail('ambiguous', target);
      const pos = found.occ[0]!;
      const F = wsHead(c.lines[pos] ?? '');
      const P = wsHead(oldLines[0]!);
      const out: string[] = [];
      for (const t of newLines) {
        if (found.tier === 2 && t !== '' && t.trim() !== '' && P !== '' && t.startsWith(P)) out.push(F + t.slice(P.length));
        else out.push(t);
      }
      const lines2 = [...c.lines.slice(0, pos), ...out, ...c.lines.slice(pos + oldLines.length)];
      tree.now.set(target, fromContent({ lines: lines2, final: c.final, br: c.br }));
    });
  }
  return edits;
}

/* ---------------------------------------------------------------- V4A */

function parseV4a(lines: string[]): Edit[] {
  const n = lines.length;
  let first = -1;
  for (let i = 0; i < n; i++) if (!blank(lines[i]!)) { first = i; break; }
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first < 0 ? 1 : first + 1}`);
  let last = -1;
  for (let i = n - 1; i >= 0; i--) if (!blank(lines[i]!)) { last = i; break; }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);

  const edits: Edit[] = [];
  let i = first + 1;
  const sections: { kind: string; path: string; moveTo: string | null; lines: BodyLine[]; chunks: Hunk[]; at: number }[] = [];
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) { i += 1; continue; }
    let kind: string | null = null;
    let p = '';
    if (l.startsWith('*** Add File: ')) { kind = 'add'; p = l.slice('*** Add File: '.length).trim(); }
    else if (l.startsWith('*** Delete File: ')) { kind = 'del'; p = l.slice('*** Delete File: '.length).trim(); }
    else if (l.startsWith('*** Update File: ')) { kind = 'upd'; p = l.slice('*** Update File: '.length).trim(); }
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const sec = { kind, path: p, moveTo: null as string | null, lines: [] as BodyLine[], chunks: [] as Hunk[], at: i };
    i += 1;
    if (kind === 'upd' && (lines[i] ?? '').startsWith('*** Move to: ')) {
      sec.moveTo = lines[i]!.slice('*** Move to: '.length).trim();
      i += 1;
    }
    // skip blank lines before content
    while (i < last && blank(lines[i]!) && !(lines[i]!.startsWith('*** '))) i += 1;
    if (kind === 'add') {
      while (i < last) {
        const b = lines[i]!;
        if (b.startsWith('*** ')) break;
        if (b.startsWith('+')) { sec.lines.push({ kind: 'new', text: b.slice(1) }); i += 1; continue; }
        if (blank(b)) { sec.lines.push({ kind: 'new', text: '' }); i += 1; continue; }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      // trim trailing blank lines of the section
      while (sec.lines.length > 0 && sec.lines[sec.lines.length - 1]!.text === '') sec.lines.pop();
    } else if (kind === 'del') {
      while (i < last && blank(lines[i]!) && !lines[i]!.startsWith('*** ')) i += 1;
      if (i < last && !lines[i]!.startsWith('*** ')) throw new Exit2(`error: parse ${i + 1}`);
    } else {
      // update: chunks
      let cur: Hunk | null = null;
      const closeChunk = () => {
        if (cur !== null) {
          while (cur.body.length > 0 && cur.body[cur.body.length - 1]!.kind === 'ctx' && cur.body[cur.body.length - 1]!.text === '') cur.body.pop();
          sec.chunks.push(cur);
          cur = null;
        }
      };
      while (i < last) {
        const b = lines[i]!;
        if (b.startsWith('*** Update File: ') || b.startsWith('*** Add File: ') || b.startsWith('*** Delete File: ')) break;
        if (b.startsWith('*** End of File')) { if (cur) { cur.eof = true; closeChunk(); } i += 1; continue; }
        if (b.startsWith('@@')) {
          closeChunk();
          const anchor = b.slice(2).trim();
          cur = { a: 0, body: [], anchor: anchor === '' ? null : anchor, eof: false };
          i += 1;
          continue;
        }
        if (b.startsWith(' ')) { if (!cur) cur = { a: 0, body: [], anchor: null, eof: false }; cur.body.push({ kind: 'ctx', text: b.slice(1) }); i += 1; continue; }
        if (b.startsWith('-')) { if (!cur) cur = { a: 0, body: [], anchor: null, eof: false }; cur.body.push({ kind: 'old', text: b.slice(1) }); i += 1; continue; }
        if (b.startsWith('+')) { if (!cur) cur = { a: 0, body: [], anchor: null, eof: false }; cur.body.push({ kind: 'new', text: b.slice(1) }); i += 1; continue; }
        if (blank(b)) { if (!cur) cur = { a: 0, body: [], anchor: null, eof: false }; cur.body.push({ kind: 'ctx', text: '' }); i += 1; continue; }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      closeChunk();
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.at + 1}`);
      while (i < last && blank(lines[i]!)) i += 1;
    }
    sections.push(sec);
  }

  for (const sec of sections) {
    edits.push((tree) => {
      const p = sec.path;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (sec.kind === 'add') {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const text = sec.lines.length === 0 ? '' : sec.lines.map((b) => b.text).join('\n') + '\n';
        tree.now.set(p, text);
        return;
      }
      if (sec.kind === 'del') {
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const isMove = sec.moveTo !== null;
      if (isMove) {
        if (!safe(sec.moveTo!)) throw new Fail('unsafe', sec.moveTo!);
        if (tree.get(sec.moveTo!) !== null) throw new Fail('exists', sec.moveTo!);
      }
      let content = toContent(before);
      let cursor = 0;
      for (const ch of sec.chunks) {
        if (ch.anchor !== null) {
          let found = -1;
          let at = 0;
          for (let t = 0; t <= (strict ? 0 : 2) && found < 0; t++) {
            for (let k = cursor; k < content.lines.length; k++) {
              if (eq(content.lines[k]!, ch.anchor, t)) { found = k; at = t; break; }
            }
          }
          if (found < 0) throw new Fail('no-match', p);
          cursor = found + 1;
        }
        const O: string[] = [];
        const N: { ctx: boolean; text: string; oi: number }[] = [];
        for (const b of ch.body) {
          if (b.kind === 'ctx') { N.push({ ctx: true, text: b.text, oi: O.length }); O.push(b.text); }
          else if (b.kind === 'old') O.push(b.text);
          else if (b.kind === 'new') N.push({ ctx: false, text: b.text, oi: -1 });
        }
        let pos: number;
        let tier = 0;
        if (O.length === 0) {
          pos = ch.eof ? content.lines.length : Math.min(cursor, content.lines.length);
        } else {
          const found = findTier(content.lines.slice(cursor), O, strict);
          let occ: number[];
          if (found === null) throw new Fail('no-match', p);
          tier = found.tier;
          occ = found.occ.map((x) => x + cursor);
          if (ch.eof) occ = occ.filter((x) => x + O.length === content.lines.length);
          if (occ.length === 0) throw new Fail('no-match', p);
          pos = occ[0]!;
        }
        const F = O.length > 0 ? wsHead(content.lines[pos] ?? '') : '';
        const P = O.length > 0 ? wsHead(O[0]!) : '';
        const out: string[] = [];
        for (const x of N) {
          if (x.ctx) { out.push(content.lines[pos + x.oi] ?? x.text); }
          else if (tier === 2 && x.text !== '' && x.text.trim() !== '' && P !== '' && x.text.startsWith(P)) out.push(F + x.text.slice(P.length));
          else out.push(x.text);
        }
        const lines2 = [...content.lines.slice(0, pos), ...out, ...content.lines.slice(pos + O.length)];
        content = { lines: lines2, final: content.final, br: content.br };
        cursor = pos + out.length;
      }
      const text = fromContent(content);
      if (isMove) {
        tree.now.set(p, null);
        tree.now.set(sec.moveTo!, text);
        tree.moves.push({ from: p, to: sec.moveTo! });
      } else {
        tree.now.set(p, text);
      }
    });
  }
  return edits;
}

/* ---------------------------------------------------------------- JSON (section 9) */

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try { v = JSON.parse(text); } catch { throw new Exit2(`error: parse ${first + 1}`); }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try { e = jsonEdit(JSON.parse(l)); } catch { e = null; }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---------------------------------------------------------------- main */

let strict = false;

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines);
    else edits = parseV4a(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };

  // build change rows
  const changed: string[] = [];
  for (const [p, v] of tree.now) {
    if (tree.original(p) === v) continue;
    changed.push(p);
  }
  const moveFrom = new Map<string, string>();
  const moveTo = new Map<string, string>();
  for (const m of tree.moves) {
    if (tree.original(m.from) !== null && tree.now.get(m.to) !== null && tree.now.get(m.from) === null && tree.original(m.to) === null) {
      moveFrom.set(m.from, m.to);
      moveTo.set(m.to, m.from);
    }
  }
  const rows: { key: string; text: string }[] = [];
  for (const p of changed) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (moveFrom.has(p)) { rows.push({ key: moveFrom.get(p)!, text: `R ${p} -> ${moveFrom.get(p)}` }); continue; }
    if (moveTo.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));

  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, now); }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}