import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the source in the same ModuleLoader factory shape used by the build,
// with a controllable search boundary and a minimal hook/slot host.
const source = await readFile(new URL('../lib/client.source.js', import.meta.url), 'utf8');

function fixture(search = async () => ({ matches: [] })) {
  const components = new Map(), slots = [], sessionListeners = new Set(), timers = new Map();
  const calls = [], bindings = new Map([['a', {}], ['b', {}]]);
  let current = 'a', dispose, nextTimer = 0, loaderId, dialogHooks = [], hookIndex = 0, ownerCleanup, keyListener, modal = false;
  class Element {
    constructor(id, composer = false, editable = true) { this.id = id; this.composer = composer; this.editable = editable; this.isConnected = true; }
    matches(selector) { return selector === '[data-composer-input][contenteditable="true"]' && this.composer && this.editable; }
    closest(selector) { return selector === '[data-conversation-content][data-conversation-session]' && this.composer ? { getAttribute: () => this.id } : null; }
    focus() { document.activeElement = this; }
  }
  const document = { activeElement: null, querySelector: selector => selector === '[role="dialog"][aria-modal="true"]' && modal ? {} : null };
  const window = { __ModuleLoader__: null, addEventListener: (type, fn) => { if (type === 'keydown') keyListener = fn; }, removeEventListener: (type, fn) => { if (type === 'keydown' && keyListener === fn) keyListener = undefined; } };
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(x => x != null) }),
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    useRef: initial => dialogHooks[hookIndex++] ??= { current: initial },
    useEffect: () => {},
    useLayoutEffect: fn => { ownerCleanup = fn(); },
  };
  const moduleLoader = { load({ id, factory }) { loaderId = id; return factory(name => {
    if (name === 'react') return React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Modal: 'Modal' };
    throw new Error(`Unexpected dependency: ${name}`);
  }); } };
  const context = {
    window: Object.assign(window, { __ModuleLoader__: moduleLoader }), document, Element, AbortController,
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    searchWorkspace: (...args) => { calls.push(args); return search(...args); },
  };
  const plugin = vm.runInNewContext(`window.__ModuleLoader__.load({ id: 'dsh-content-search', factory(require) { const module = { exports: {} }; const exports = module.exports;\n${source}\nreturn module.exports; } });`, context);
  const ctx = {
    slots: { inject(name, fn) { slots.push(['inject', name]); fn(); }, register(info, component) { slots.push(['register', info.name, info.id]); components.set(info.id, component); } },
    sessions: { binding: id => bindings.get(id) },
    uiSession: { adapter: { current: { getSnapshot: () => ({ key: current }), subscribe(fn) { sessionListeners.add(fn); return () => sessionListeners.delete(fn); } } } },
    remote: { workspaceFiles: {} },
    effect(fn) { dispose = fn(); },
  };
  plugin.apply(ctx);
  const ownerCleanups = [];
  function mount(id, actions) {
    ownerCleanup = undefined;
    components.get('content-search.owner')({ sessionId: id, inputActions: actions });
    const cleanup = ownerCleanup;
    if (cleanup) ownerCleanups.push(cleanup);
    return cleanup;
  }
  function render() { hookIndex = 0; return components.get('content-search.dialog')(); }
  function nodes(tree, predicate) {
    if (!tree || typeof tree !== 'object') return [];
    return [...(predicate(tree) ? [tree] : []), ...(tree.children || []).flatMap(child => nodes(child, predicate))];
  }
  function find(predicate) { const found = nodes(render(), predicate); assert.equal(found.length, 1); return found[0]; }
  function input(label, value) { find(node => node.props['aria-label'] === label).props.onChange({ target: { value, checked: value } }); }
  function key(key, extra = {}) {
    const event = { key, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
    find(node => node.type === 'section').props.onKeyDown(event); return event;
  }
  async function flush() {
    const scheduled = [...timers.values()]; timers.clear();
    for (const timer of scheduled) { assert.equal(timer.delay, 250); await timer.fn(); }
  }
  function switchTo(id) { current = id; for (const fn of [...sessionListeners]) fn(); }
  function dispatch(target, overrides = {}) {
    document.activeElement = target;
    const event = { target, code: 'KeyF', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, defaultPrevented: false, prevented: false, stopped: false, getModifierState: () => false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...overrides };
    keyListener?.(event); return event;
  }
  return { plugin, loaderId, ctx, calls, bindings, timers, slots, mount, render, find, nodes, input, key, flush, switchTo, dispatch,
    element: (id, composer = false, editable = true) => new Element(id, composer, editable),
    setModal(value) { modal = value; },
    get hasKeyListener() { return !!keyListener; },
    open: () => dispatch(new Element(current, true)),
    cleanup() { for (const fn of ownerCleanups.reverse()) fn(); dispose(); },
  };
}

function actions() {
  const span = { start: 2, end: 4 }, insertions = [];
  return { span, insertions, captureInsertion: () => span, insertText(text, captured) { insertions.push({ text, captured }); return true; } };
}
const rows = (...paths) => ({ matches: paths.map((path, i) => ({ path, line: i + 1, preview: 'found' })) });
const status = f => f.find(node => node.props.role === 'status').children.join('');

test('handles Ctrl+F only for the current editable composer and never registers a global shortcut', () => {
  const f = fixture();
  assert.equal(f.loaderId, 'dsh-content-search');
  assert.deepEqual(f.slots, [
    ['inject', 'conversation.input.dock'], ['register', 'conversation.input.dock', 'content-search.owner'],
    ['inject', 'shell.overlay'], ['register', 'shell.overlay', 'content-search.dialog'],
  ]);
  assert.deepEqual(Array.from(f.plugin.inject), ['slots', 'sessions', 'uiSession', 'remote', 'remote.workspaceFiles']);
  const a = actions(); f.mount('a', a);
  for (const target of [f.element('a'), f.element('b', true), f.element('a', true, false)]) {
    const event = f.dispatch(target); assert.equal(event.prevented, false); assert.equal(f.render(), null);
  }
  const input = f.element('a', true);
  for (const overrides of [{ isComposing: true }, { repeat: true }, { altKey: true }, { defaultPrevented: true }, { ctrlKey: true, metaKey: true }, { code: 'KeyG' }]) {
    assert.equal(f.dispatch(input, overrides).prevented, false);
  }
  f.setModal(true); assert.equal(f.dispatch(input).prevented, false); f.setModal(false);
  const event = f.dispatch(input); assert.equal(event.prevented, true); assert.equal(event.stopped, true); assert.match(status(f), /输入内容开始搜索/);
  f.cleanup(); assert.equal(f.hasKeyListener, false);
});

test('debounces inputs, binds search to the captured session, and inserts the keyboard selection', async () => {
  const f = fixture(async () => ({ ...rows('src/first.js', 'src/with space.js'), truncated: true, warnings: ['部分文件跳过'] }));
  const a = actions(); f.mount('a', a); f.open();
  f.input('搜索内容', 'needle'); f.input('包含文件 glob', '*.js');
  f.input('全词匹配', true);
  assert.equal(f.timers.size, 1);
  assert.match(status(f), /正在搜索/);
  await f.flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], f.ctx.remote); assert.equal(f.calls[0][1], 'a');
  assert.equal(f.calls[0][2].query, 'needle'); assert.equal(f.calls[0][2].include, '*.js'); assert.equal(f.calls[0][2].wholeWord, true);
  assert.equal(f.calls[0][3].aborted, false);
  assert.match(status(f), /2 条匹配（结果不完整）/);
  assert.equal(f.nodes(f.render(), node => node.children?.includes('部分内容未搜索：')).length, 1);
  assert.equal(f.key('Enter', { isComposing: true }).prevented, false);
  assert.equal(a.insertions.length, 0);
  assert.equal(f.key('ArrowUp').prevented, true); // wraps from first to last
  assert.equal(f.key('Enter').prevented, true);
  assert.equal(a.insertions.length, 1);
  assert.equal(a.insertions[0].text, ' @"src/with space.js" ');
  assert.equal(a.insertions[0].captured, a.span);
  assert.equal(f.render(), null);
  f.cleanup();
});

test('mouse selection inserts a simple reference; unsafe paths and stale drafts do not close', async () => {
  const f = fixture(async () => rows('safe.js', 'bad"name.js'));
  const a = actions(); f.mount('a', a); f.open(); f.input('搜索内容', 'x'); await f.flush();
  let options = f.nodes(f.render(), node => node.props.role === 'option');
  options[1].props.onClick();
  assert.match(status(f), /路径不能安全/); assert.equal(a.insertions.length, 0);
  a.insertText = (text, span) => { a.insertions.push({ text, captured: span }); return false; };
  options = f.nodes(f.render(), node => node.props.role === 'option'); options[0].props.onClick();
  assert.match(status(f), /草稿已变化/); assert.equal(a.insertions[0].text, ' @safe.js ');
  a.insertText = (text, span) => { a.insertions.push({ text, captured: span }); return true; };
  f.nodes(f.render(), node => node.props.role === 'option')[0].props.onClick();
  assert.equal(a.insertions[1].captured, a.span); assert.equal(f.render(), null);
  f.cleanup();
});

test('switching sessions cancels in-flight search and never edits either draft even if it resolves late', async () => {
  let resolveSearch, signal;
  const f = fixture((_remote, _id, _options, s) => { signal = s; return new Promise(resolve => { resolveSearch = resolve; }); });
  const a = actions(), b = actions(); f.mount('a', a); f.mount('b', b); f.open(); f.input('搜索内容', 'needle');
  const pending = f.flush();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][1], 'a');
  f.switchTo('b');
  assert.equal(signal.aborted, true); assert.equal(f.render(), null);
  resolveSearch(rows('late.js')); await pending;
  assert.equal(f.render(), null); assert.equal(a.insertions.length, 0); assert.equal(b.insertions.length, 0);
  f.open(); f.input('搜索内容', 'new'); assert.equal(f.timers.size, 1);
  f.switchTo('a'); assert.equal(f.timers.size, 0);
  assert.equal(a.insertions.length, 0); assert.equal(b.insertions.length, 0);
  f.cleanup();
});

test('a stale result handler after a session switch cannot edit either draft', async () => {
  const f = fixture(async () => rows('safe.js'));
  const a = actions(), b = actions(); f.mount('a', a); f.mount('b', b);
  f.open(); f.input('搜索内容', 'x'); await f.flush();
  const staleOption = f.nodes(f.render(), node => node.props.role === 'option')[0];
  f.switchTo('b'); staleOption.props.onClick();
  assert.equal(f.render(), null); assert.equal(a.insertions.length, 0); assert.equal(b.insertions.length, 0);
  f.open(); f.input('搜索内容', 'x'); await f.flush();
  f.key('Enter');
  assert.equal(a.insertions.length, 0); assert.equal(b.insertions.length, 1);
  assert.equal(b.insertions[0].captured, b.span); assert.equal(f.calls[1][1], 'b');
  f.cleanup();
});

test('binding replacement and owner unmount prevent insertion into a different draft', async () => {
  const f = fixture(async () => rows('safe.js')); const a = actions();
  const unmount = f.mount('a', a); f.open(); f.input('搜索内容', 'x'); await f.flush();
  const oldOption = f.nodes(f.render(), node => node.props.role === 'option')[0];
  f.bindings.set('a', {}); oldOption.props.onClick();
  assert.match(status(f), /会话已切换或关闭/); assert.equal(a.insertions.length, 0);
  f.key('Escape'); f.open(); f.input('搜索内容', 'x'); await f.flush();
  unmount(); assert.equal(f.render(), null); assert.equal(a.insertions.length, 0);
  f.cleanup();
});

test('incremental results preserve selected file and can be inserted while searching', async () => {
  let progress, finish;
  const f = fixture((_remote, _id, _options, _signal, onProgress) => { progress = onProgress; return new Promise(resolve => { finish = resolve; }); });
  const a = actions(); f.mount('a', a); f.open(); f.input('搜索内容', 'needle');
  const pending = f.flush();
  progress({ ...rows('a.js', 'b.js'), stats: { files: 2 } });
  assert.match(status(f), /已找到 2 条/);
  f.key('ArrowDown');
  progress({ matches: [{ path: 'b.js', line: 2, preview: 'found' }, { path: 'a.js', line: 1, preview: 'found' }, { path: 'c.js', line: 3, preview: 'found' }], stats: { files: 3 } });
  f.key('Enter');
  assert.equal(a.insertions[0].text, ' @b.js ');
  assert.equal(f.render(), null);
  finish(rows('a.js', 'b.js')); await pending;
  assert.equal(f.render(), null);
  f.cleanup();
});

test('empty input cancels debounce and search failures are shown without editing', async () => {
  const f = fixture(async () => { throw new Error('remote offline'); }); const a = actions();
  f.mount('a', a); f.open(); f.input('搜索内容', 'x'); f.input('搜索内容', '  ');
  assert.equal(f.timers.size, 0); assert.match(status(f), /输入内容开始搜索/);
  f.input('搜索内容', 'x'); await f.flush();
  assert.equal(status(f), 'remote offline'); assert.equal(a.insertions.length, 0);
  const escape = f.key('Escape'); assert.equal(escape.prevented, true); assert.equal(escape.stopped, true); assert.equal(f.render(), null);
  f.cleanup();
});
