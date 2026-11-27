import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../lib/search.js', import.meta.url), 'utf8');
const { searchWorkspace, SEARCH_LIMITS } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const ok = value => ({ ok: true, value });
const fail = code => ({ ok: false, error: Object.assign(new Error(code), { code }) });
function fixture(tree, pages, hook = () => {}) {
  const calls = [];
  const remote = { workspaceFiles: {
    async list(id, path, signal) { calls.push(['list', id, path]); hook(signal, 'list', path); return tree[path] ?? fail('workspace-file/not-found'); },
    async read(id, path, range, signal) { calls.push(['read', id, path, range.offset]); hook(signal, 'read', path); return pages[path]?.[range.offset] ?? fail('workspace-file/not-found'); },
  } };
  return { remote, calls };
}
const entry = (name, type, size) => ({ name, type, ...(size === undefined ? {} : { size }) });
const list = (...entries) => ok({ entries, truncated: false });
const page = (text, lines, eof = true, version = 'v1', bytes = 100) => ok({ text, lines, eof, version, bytes });

test('matches nested basename and ** globs; excludes directories and symlinks', async () => {
  const { remote, calls } = fixture({ '.': list(entry('src','directory'), entry('.git','directory'), entry('node_modules','directory'), entry('link','symlink'), entry('root.md','file')), src: list(entry('nested','directory'), entry('a.ts','file'), entry('build','directory')), 'src/nested': list(entry('b.ts','file'), entry('bad.txt','file')) }, { 'root.md': { 1: page('first\nHello', 2) }, 'src/a.ts': {1: page('HELLO world',1)}, 'src/nested/b.ts': {1: page('hello',1)} });
  const res = await searchWorkspace(remote, 's', { query:'hello', include:'src/**/*.ts, *.md' });
  assert.deepEqual(res.matches, [{ path:'root.md', line:2, preview:'Hello' }, { path:'src/a.ts', line:1, preview:'HELLO world' }, { path:'src/nested/b.ts', line:1, preview:'hello' }]);
  assert.equal(res.truncated, false);
  assert.deepEqual(calls.filter(c => c[0] === 'list').map(c => c[2]), ['.', 'src', 'src/nested']);
});

test('whole-word mode matches token boundaries and preserves default substring search', async () => {
  const { remote } = fixture({ '.': list(entry('words.txt','file')) }, { 'words.txt': { 1: page('cat\nconcatenate\nscat\ncat_\ncat-dog\ndog_cat\ncat', 7) } });
  const partial = await searchWorkspace(remote, 's', { query: 'cat' });
  assert.equal(partial.matches.length, 7);
  const whole = await searchWorkspace(remote, 's', { query: 'cat', wholeWord: true });
  assert.equal(whole.matches.length, 3);
  assert.deepEqual(whole.matches.map(m => m.line), [1, 5, 7]);
});

test('whole-word mode recognizes punctuation and validates its option', async () => {
  const { remote } = fixture({ '.': list(entry('words.txt','file')) }, { 'words.txt': { 1: page('cat\ncat!\n(cat)\ncat-dog\ndog_cat', 5) } });
  const result = await searchWorkspace(remote, 's', { query: 'cat', wholeWord: true });
  assert.equal(result.matches.length, 4);
  assert.deepEqual(result.matches.map(m => m.line), [1, 2, 3, 4]);
  await assert.rejects(searchWorkspace(remote, 's', { query: 'cat', wholeWord: 'yes' }), /wholeWord must be boolean/);
});

test('whole-word mode checks boundaries in case-folded text after Unicode expansions', async () => {
  const { remote } = fixture({ '.': list(entry('unicode.txt','file')) }, { 'unicode.txt': { 1: page('İ-foo\nİfoo\nfooİ', 3) } });
  const result = await searchWorkspace(remote, 's', { query: 'foo', wholeWord: true });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].line, 1);
});

test('case sensitive query and line numbers across pages', async () => {
  const { remote } = fixture({ '.': list(entry('a.ts','file')) }, { 'a.ts': { 1: page('hello',1,false), 2: page('HELLO\nhello',2,true) } });
  const result = await searchWorkspace(remote, 's', { query:'hello', caseSensitive:true });
  assert.deepEqual(result.matches.map(m => m.line), [1,3]);
});

test('never publishes earlier page if later page is binary or changed', async () => {
  const { remote } = fixture({ '.': list(entry('binary','file'), entry('changed','file')) }, { binary: {1: page('match',1,false), 2: fail('workspace-file/not-text')}, changed: {1: page('match',1,false), 2: page('match',1,true,'v2')} });
  const result = await searchWorkspace(remote, 's', { query:'match' });
  assert.deepEqual(result.matches, []);
  assert.equal(result.truncated, true);
  assert.equal(result.warnings.length, 2);
});

test('listing truncation, inaccessible directory, and big file are reported', async () => {
  const { remote, calls } = fixture({ '.': ok({ entries:[entry('no','directory'), entry('big','file', SEARCH_LIMITS.fileBytes+1)], truncated:true }) }, {});
  const result = await searchWorkspace(remote, 's', { query:'x' });
  assert.equal(result.truncated, true);
  assert.equal(result.warnings.length, 3);
  assert.equal(calls.filter(c => c[0] === 'read').length, 0);
});

test('abort propagates into in-flight remote call', async () => {
  const controller = new AbortController();
  const remote = { workspaceFiles: { list(_s,_p,signal) { return new Promise((_resolve,reject) => signal.addEventListener('abort', () => reject(signal.reason), {once:true})); }, read() { throw new Error('not called'); } } };
  const pending = searchWorkspace(remote, 's', { query:'x' }, controller.signal);
  controller.abort(new Error('cancelled'));
  await assert.rejects(pending, /cancelled/);
});

test('validates input and propagates root access errors', async () => {
  const { remote } = fixture({}, {});
  await assert.rejects(searchWorkspace(remote, 's', { query:'x', include:'../*' }), /glob/);
  await assert.rejects(searchWorkspace(remote, 's', { query:'' }), /query/);
  await assert.rejects(searchWorkspace(remote, 's', { query:'x' }), /not-found/);
});

test('caps match count and preview and emits snapshots', async () => {
  const text = ('xx' + 'a'.repeat(600) + '\n').repeat(500).slice(0,-1);
  const { remote } = fixture({ '.': list(entry('x','file')) }, { x: {1: page(text,500,true,'v1', text.length) } });
  // Use short lines so the file is within the byte limit.
  const short = ('xx\n').repeat(500).slice(0,-1);
  const { remote: remote2 } = fixture({ '.': list(entry('x','file')) }, { x: {1: page(short,500)} });
  let progress = 0;
  const capped = await searchWorkspace(remote2, 's', { query:'xx' }, undefined, () => progress++);
  assert.equal(capped.matches.length, 500); assert.equal(capped.truncated, true); assert.ok(progress > 0);
  const oversized = await searchWorkspace(remote, 's', {query:'xx'});
  assert.equal(oversized.matches.length, 0); assert.equal(oversized.truncated, true);
  const long = fixture({ '.': list(entry('x','file')) }, { x: {1: page('xx' + 'a'.repeat(600), 1)} });
  assert.equal((await searchWorkspace(long.remote, 's', {query:'xx'})).matches[0].preview.length, 501);
});

test('rejects unsafe names, never follows symlinks', async () => {
  const { remote, calls } = fixture({ '.': list(entry('../secret','file'), entry('C:\\secret','file'), entry('folder','symlink')) }, {});
  const result = await searchWorkspace(remote, 's', {query:'secret'});
  assert.equal(result.truncated, true); assert.equal(calls.length, 1);
});
