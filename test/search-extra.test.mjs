import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../lib/search.js', import.meta.url), 'utf8');
const { searchWorkspace } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const ok = value => ({ ok: true, value });
function remote(pages) { return { workspaceFiles: {
  list: async () => ok({ entries: [{ name: 'file.txt', type: 'file' }], truncated: false }),
  read: async (_id, _path, range) => ok(pages[range.offset]),
} }; }
const page = (text, lines, eof) => ({ text, lines, eof, version: 'v1', bytes: 5000 });

test('previews include distant matches, including case-fold expansion', async () => {
  const lines = ['a'.repeat(900) + 'Needle' + 'z'.repeat(700), 'İ'.repeat(600) + 'TARGET' + 'z'.repeat(700)];
  for (const [i, query] of ['needle', 'target'].entries()) {
    const result = await searchWorkspace(remote({1: page(lines[i], 1, true)}), 's', { query });
    const preview = result.matches[0].preview;
    assert.ok(preview.toLowerCase().includes(query));
    assert.ok(preview.startsWith('…') && preview.endsWith('…'));
    assert.ok(preview.length <= 502);
  }
});

test('a single file with more than 500 matches reports omitted matches', async () => {
  const first = Array(500).fill('needle').join('\n');
  const result = await searchWorkspace(remote({1: page(first, 500, false), 501: page('needle', 1, true)}), 's', {query:'needle'});
  assert.equal(result.matches.length, 500);
  assert.equal(result.truncated, true);
  assert.ok(result.warnings.includes('Match limit reached'));
});
