import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../lib/search.js', import.meta.url), 'utf8');
async function load(changes = {}) {
  let code = source;
  for (const [name, value] of Object.entries(changes)) {
    const pattern = new RegExp(`\\b${name}: \\d+`);
    assert.match(code, pattern);
    code = code.replace(pattern, `${name}: ${value}`);
  }
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}
const ok = value => ({ ok: true, value });
const listing = entries => ok({ entries, truncated: false });
const entry = (name, type) => ({ name, type });
const page = text => ok({ text, lines: 1, eof: true, version: 'v', bytes: text.length });
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

test('scans thousands of directories and filtered Java files within expanded budgets', async () => {
  const { searchWorkspace } = await load();
  let reads = 0;
  const remote = { workspaceFiles: {
    list: async (_id, path) => path === '.'
      ? listing(Array.from({ length: 2133 }, (_, i) => entry(`dir${i}`, 'directory')))
      : listing([entry('first.java', 'file'), entry('second.java', 'file'), entry('other.txt', 'file')]),
    read: async (_id, path) => { assert.match(path, /\.java$/); reads++; return page('nothing'); },
  } };
  const result = await searchWorkspace(remote, 'session', { query: 'needle', include: '*.java' });
  assert.equal(result.stats.directories, 2134);
  assert.equal(result.stats.files, 4266);
  assert.equal(reads, 4266);
  assert.equal(result.truncated, false);
});

test('shared list and read concurrency is bounded and progress is a stable prefix', async () => {
  const { searchWorkspace, SEARCH_LIMITS } = await load();
  const first = deferred(), second = deferred(), updates = [];
  let active = 0, peak = 0, firstStarted = false, secondStarted = false;
  const remote = { workspaceFiles: {
    async list(_id, path) {
      active++; peak = Math.max(peak, active);
      try {
        if (path === '.') return listing([entry('a', 'file'), entry('b', 'file'), ...Array.from({ length: 20 }, (_, i) => entry(`dir${i}`, 'directory'))]);
        await new Promise(resolve => setTimeout(resolve, 3));
        return listing([]);
      } finally { active--; }
    },
    async read(_id, path) {
      active++; peak = Math.max(peak, active);
      try {
        if (path === 'a') { firstStarted = true; return await first.promise; }
        secondStarted = true; return await second.promise;
      } finally { active--; }
    },
  } };
  const pending = searchWorkspace(remote, 's', { query: 'hit' }, undefined, value => updates.push(value));
  while (!firstStarted || !secondStarted) await new Promise(resolve => setTimeout(resolve, 1));
  second.resolve(page('hit b'));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(updates.length, 0);
  first.resolve(page('hit a'));
  const result = await pending;
  assert.ok(peak <= SEARCH_LIMITS.concurrency);
  assert.ok(peak > 1);
  assert.deepEqual(result.matches.map(m => m.path), ['a', 'b']);
  assert.ok(updates.length > 0);
  for (const update of updates) assert.deepEqual(update.matches, result.matches.slice(0, update.matches.length));
  assert.equal(updates.length, 1, 'rapid commits are coalesced');
});

test('timeout returns completed later files, even when a remote ignores abort', async () => {
  const { searchWorkspace } = await load({ timeoutMs: 40 });
  let control;
  const updates = [];
  const remote = { workspaceFiles: {
    list: async () => listing([entry('slow', 'file'), entry('ready', 'file')]),
    read: async (_id, path, _range, signal) => {
      control = signal;
      return path === 'slow' ? new Promise(() => {}) : page('hit');
    },
  } };
  const result = await searchWorkspace(remote, 's', { query: 'hit' }, undefined, value => updates.push(value));
  assert.deepEqual(result.matches.map(m => m.path), ['ready']);
  assert.equal(result.truncated, true);
  assert.ok(result.warnings.some(w => /timed out/.test(w)));
  assert.equal(control.aborted, true);
  assert.equal(updates.length, 0);
});

test('external cancellation rejects even if remote ignores abort', async () => {
  const { searchWorkspace } = await load();
  const started = deferred(), controller = new AbortController();
  const remote = { workspaceFiles: {
    list: async () => { started.resolve(); return new Promise(() => {}); },
    read: async () => { throw new Error('unexpected'); },
  } };
  const pending = searchWorkspace(remote, 's', { query: 'hit' }, controller.signal);
  await started.promise;
  controller.abort(new Error('user cancelled'));
  await assert.rejects(pending, /user cancelled/);
});

test('each exhausted budget reports its specific cause and never claims completeness', async () => {
  for (const [key, expected] of [['directories', 'Directory'], ['entries', 'Entry'], ['files', 'File'], ['pages', 'Page']]) {
    const { searchWorkspace } = await load({ [key]: 1 });
    const remote = { workspaceFiles: {
      list: async (_id, path) => path === '.' ? listing([entry('a', 'directory'), entry('b', 'file'), entry('c', 'file')]) : listing([]),
      read: async () => page('no match'),
    } };
    const result = await searchWorkspace(remote, 's', { query: 'hit' });
    assert.equal(result.truncated, true, key);
    assert.ok(result.warnings.includes(`${expected} limit reached (1)`), `${key}: ${result.warnings}`);
  }
});
