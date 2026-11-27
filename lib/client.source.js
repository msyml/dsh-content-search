const React = require('react');
const h = React.createElement;
const { Modal } = require('@deepseek-ai/dsh-client-ui-primitives');
const { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } = React;
exports.inject = ['slots', 'sessions', 'uiSession', 'remote', 'remote.workspaceFiles', 'betterSidebar'];
function mention(path) {
  if (typeof path !== 'string' || !path || /[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return null;
  return /\s/u.test(path) ? `@"${path}"` : `@${path}`;
}
function highlightPreview(text, query, caseSensitive = false, wholeWord = false) {
  if (!query) return text;
  const foldedText = caseSensitive ? text : text.toLowerCase();
  const foldedQuery = caseSensitive ? query : query.toLowerCase();
  const wordChar = char => !!char && /[\p{L}\p{M}\p{N}_]/u.test(char);
  const startsWord = wordChar(Array.from(foldedQuery)[0]);
  const endsWord = wordChar(Array.from(foldedQuery).at(-1));
  let index = foldedText.indexOf(foldedQuery);
  while (index >= 0) {
    const end = index + foldedQuery.length;
    const before = previousChar(foldedText, index), after = nextChar(foldedText, end);
    if (!wholeWord || (!startsWord || !wordChar(before)) && (!endsWord || !wordChar(after))) {
      const startOriginal = caseSensitive ? index : originalIndex(text, index);
      const endOriginal = caseSensitive ? end : originalIndex(text, end - 1, true);
      return [text.slice(0, startOriginal), h('mark', { key: 'match', className: 'dsh-cs-highlight' }, text.slice(startOriginal, endOriginal)), text.slice(endOriginal)];
    }
    index = foldedText.indexOf(foldedQuery, index + 1);
  }
  return text;
}
function warningLabel(warning) {
  const limit = /^(Directory|Entry|File|Page) limit reached \((\d+)\)$/.exec(warning);
  if (limit) return `${{ Directory: '目录数量', Entry: '目录条目', File: '文件数量', Page: '文件页数' }[limit[1]]}达到上限（${limit[2]}）`;
  if (warning.startsWith('Search timed out')) return '搜索超时，仅显示已完成的结果';
  const labels = { 'Some directory entries were omitted by the Host': '部分目录条目超过上限', 'Some directories could not be listed': '部分目录无法读取', 'Some files exceeded the size limit': '部分文件超过大小上限', 'Some files changed during search': '部分文件在搜索期间发生变化', 'Some binary or non-UTF-8 files were skipped': '跳过了二进制或非 UTF-8 文件', 'Some files could not be read': '部分文件无法读取', 'Search stopped at a scan limit': '达到搜索范围上限', 'Match limit reached': '达到匹配数量上限', 'Invalid directory entry skipped': '跳过了无效目录条目' };
  return labels[warning] || warning;
}
exports.apply = function apply(ctx) {
  let state = { open: false, query: '', include: '', caseSensitive: false, wholeWord: false, status: 'idle', matches: [], selected: 0, message: '', truncated: false, warnings: [] };
  const listeners = new Set(), owners = new Map();
  let target = null, request = null, timer = null, sequence = 0, active = true, previousFocus = null, suppressOpenUntil = 0;
  const publish = patch => { state = { ...state, ...patch }; for (const listener of [...listeners]) listener(); };
  const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
  const currentId = () => ctx.uiSession.adapter.current.getSnapshot().key;
  const cancel = () => { sequence++; if (timer !== null) clearTimeout(timer); timer = null; if (request) request.abort(); request = null; };
  const valid = () => !!target && currentId() === target.id && ctx.sessions.binding(target.id) === target.binding && owners.get(target.id) === target.owner;
  const close = () => {
    cancel(); const focus = previousFocus; previousFocus = null; const canFocus = valid(); target = null;
    publish({ open: false, status: 'idle', message: '', matches: [] });
    if (canFocus && focus && focus.isConnected && typeof focus.focus === 'function') focus.focus();
  };
  const schedule = (query, include, caseSensitive = state.caseSensitive, wholeWord = state.wholeWord) => {
    cancel();
    if (!target || !valid()) { publish({ status: 'error', matches: [], message: '当前会话不可用，请关闭后重试。', selected: 0 }); return; }
    if (!query.trim()) { publish({ status: 'idle', matches: [], selected: 0, message: '' }); return; }
    const seq = sequence;
    publish({ status: 'waiting', matches: [], selected: 0, message: '', warnings: [], truncated: false });
    timer = setTimeout(async () => {
      timer = null; const controller = new AbortController(); request = controller;
      publish({ status: 'loading' });
      try {
        const applyResult = (result, complete) => {
          if (!active || controller.signal.aborted || seq !== sequence || !valid()) return;
          if (!result || !Array.isArray(result.matches)) throw new Error('搜索服务返回了无效结果。');
          const selected = state.matches[state.selected];
          const index = selected ? result.matches.findIndex(item => item.path === selected.path && item.line === selected.line) : -1;
          publish({ status: complete ? 'done' : 'loading', matches: result.matches, selected: index < 0 ? 0 : index, truncated: !!result.truncated, warnings: Array.isArray(result.warnings) ? result.warnings : [], stats: result.stats });
        };
        const result = await searchWorkspace(ctx.remote, target.id, { query, include, caseSensitive, wholeWord }, controller.signal, progress => applyResult(progress, false));
        applyResult(result, true);
      } catch (error) {
        if (!active || controller.signal.aborted || seq !== sequence || !valid()) return;
        publish({ status: 'error', message: error?.message || '搜索失败，请检查工作区和连接。', matches: [] });
      } finally { if (request === controller) request = null; }
    }, 250);
  };
  const open = () => {
    if (Date.now() < suppressOpenUntil) return;
    if (state.open) { document.querySelector('[data-dsh-content-search-query]')?.focus(); return; }
    const id = currentId(), owner = id === undefined ? undefined : owners.get(id);
    previousFocus = document.activeElement; target = null;
    if (id && owner) {
      try {
        const binding = ctx.sessions.binding(id);
        if (binding && typeof owner.actions.captureInsertion === 'function' && typeof owner.actions.insertText === 'function') target = { id, owner, binding, span: owner.actions.captureInsertion() };
      } catch { target = null; }
    }
    publish({ open: true, query: '', include: '', caseSensitive: false, wholeWord: false, matches: [], selected: 0, truncated: false, warnings: [], status: target ? 'idle' : 'error', message: target ? '' : '没有可用的当前会话或输入框。' });
  };
  const select = index => {
    if (!valid()) { cancel(); publish({ status: 'error', message: '会话已切换或关闭，请重新打开搜索。', matches: [] }); return; }
    const reference = mention(state.matches[index]?.path);
    const text = reference ? ` ${reference} ` : null;
    if (!text) { publish({ status: 'error', message: '此路径不能安全地表示为 @引用。' }); return; }
    try {
      if (!target.owner.actions.insertText(text, target.span)) { publish({ status: 'error', message: '草稿已变化或暂不可编辑；未插入，请关闭后重新打开搜索。' }); return; }
      suppressOpenUntil = Date.now() + 250;
      close();
    } catch { publish({ status: 'error', message: '无法插入到当前会话；草稿未替换。' }); }
  };
  function SidebarSearch({ scope }) {
    const [query, setQuery] = useState('');
    const [include, setInclude] = useState('');
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [wholeWord, setWholeWord] = useState(false);
    const [matches, setMatches] = useState([]);
    const [status, setStatus] = useState('输入关键词开始搜索。');
    const [warnings, setWarnings] = useState([]);
    const [truncated, setTruncated] = useState(false);
    const [selected, setSelected] = useState(0);
    const queryRef = useRef(null), listRef = useRef(null), optionRefs = useRef([]);
    useEffect(() => {
      if (!query.trim()) { setMatches([]); setWarnings([]); setTruncated(false); setStatus('输入关键词开始搜索。'); return; }
      const controller = new AbortController();
      setMatches([]); setWarnings([]); setTruncated(false); setStatus('正在搜索…'); setSelected(0);
      const timer = setTimeout(async () => {
        try {
          const result = await searchWorkspace(ctx.remote, scope.sessionId, { query, include, caseSensitive, wholeWord }, controller.signal, progress => {
            if (!controller.signal.aborted) {
              setMatches(progress.matches); setWarnings(progress.warnings || []); setTruncated(!!progress.truncated);
              setStatus(`正在搜索… 已找到 ${progress.matches.length} 条${progress.stats ? `（已检查 ${progress.stats.files} 个文件）` : ''}`);
            }
          });
          if (!controller.signal.aborted) {
            setMatches(result.matches); setWarnings(result.warnings || []); setTruncated(!!result.truncated);
            setStatus(`${result.matches.length} 条匹配${result.truncated ? '（结果不完整）' : ''}${result.stats ? ` · 已检查 ${result.stats.files} 个文件` : ''}`);
          }
        } catch (error) {
          if (!controller.signal.aborted) { setMatches([]); setStatus(error?.message || '搜索失败，请检查工作区和连接。'); }
        }
      }, 250);
      return () => { clearTimeout(timer); controller.abort(); };
    }, [query, include, caseSensitive, wholeWord, scope.sessionId]);
    useEffect(() => { optionRefs.current[selected]?.scrollIntoView?.({ block: 'nearest' }); }, [selected, matches]);
    const insert = path => {
      const owner = owners.get(scope.sessionId);
      if (!owner || !ctx.sessions.binding(scope.sessionId)) { setStatus('当前会话输入框不可用；请切回该会话后重试。'); return; }
      const reference = mention(path);
      if (!reference) { setStatus('此路径不能安全地表示为 @引用。'); return; }
      try {
        const span = owner.actions.captureInsertion();
        if (!owner.actions.insertText(` ${reference} `, span)) setStatus('草稿已变化或暂不可编辑；未插入文件引用。');
      } catch { setStatus('无法插入到当前会话；草稿未替换。'); }
    };
    const onListKeyDown = event => {
      if (event.isComposing || event.nativeEvent?.isComposing || !matches.length || event.target !== event.currentTarget) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setSelected(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault(); setSelected(event.key === 'Home' ? 0 : matches.length - 1);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); insert(matches[selected]?.path);
      }
    };
    const inputStyle = { boxSizing: 'border-box', width: '100%', minWidth: 0, height: 36, padding: '0 10px', border: '1px solid var(--dsw-alias-border-l2, #777)', borderRadius: 8, background: 'var(--dsw-alias-bg-module-platform, #242424)', color: 'var(--dsw-alias-label-primary, #eee)', font: 'inherit' };
    const labelStyle = { display: 'flex', flexDirection: 'column', gap: 5, color: 'var(--dsw-alias-label-secondary, #999)', fontSize: 12 };
    const checkStyle = { display: 'inline-flex', alignItems: 'center', gap: 7, color: 'var(--dsw-alias-label-secondary, #999)', fontSize: 12, cursor: 'pointer', userSelect: 'none' };
    return h('section', { style: { display: 'flex', flexDirection: 'column', gap: 12, height: '100%', minHeight: 0, padding: 14, color: 'var(--dsw-alias-label-primary, #eee)', fontSize: 13 } },
      h('label', { style: labelStyle }, '搜索内容', h('input', { ref: queryRef, autoFocus: true, 'aria-label': '搜索内容', placeholder: '输入关键词，默认不区分大小写', value: query, onChange: e => setQuery(e.target.value), maxLength: 1024, style: inputStyle })),
      h('label', { style: labelStyle }, '包含文件', h('input', { 'aria-label': '包含文件 glob', placeholder: '例如 *.ts, *.md', value: include, onChange: e => setInclude(e.target.value), maxLength: 1024, style: inputStyle })),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 14 } },
        h('label', { style: checkStyle }, h('input', { type: 'checkbox', checked: caseSensitive, onChange: e => setCaseSensitive(e.target.checked), 'aria-label': '区分大小写' }), '区分大小写'),
        h('label', { style: checkStyle, title: '仅匹配完整单词，不匹配其他单词中的片段' }, h('input', { type: 'checkbox', checked: wholeWord, onChange: e => setWholeWord(e.target.checked), 'aria-label': '全词匹配' }), '全词匹配')),
      h('div', { role: 'status', 'aria-live': 'polite', style: { color: 'var(--dsw-alias-label-secondary, #999)', fontSize: 12 } }, status),
      warnings.length ? h('div', { style: { color: 'var(--dsw-alias-label-secondary, #999)', fontSize: 11, lineHeight: '16px' } }, truncated ? '搜索结果不完整：' : '提示：', warnings.map(warningLabel).join('；')) : null,
      h('div', { ref: listRef, role: 'listbox', tabIndex: 0, 'aria-label': '搜索结果', 'aria-keyshortcuts': 'ArrowDown ArrowUp Home End Enter Space', onKeyDown: onListKeyDown, style: { flex: 1, minHeight: 0, overflowY: 'auto', outline: undefined } }, matches.length ? matches.map((row, i) => h('div', { id: `dsh-cs-sidebar-option-${i}`, key: `${row.path}:${row.line}:${i}`, ref: node => { optionRefs.current[i] = node; }, role: 'option', 'aria-selected': selected === i, onMouseEnter: () => setSelected(i), onClick: () => insert(row.path), style: { display: 'block', width: '100%', marginBottom: 6, padding: 9, border: `1px solid ${selected === i ? 'var(--dsw-alias-border-l2, #777)' : 'transparent'}`, borderRadius: 8, background: selected === i ? 'var(--dsw-alias-interactive-bg-hover, #555)' : 'transparent', color: 'var(--dsw-alias-label-primary, #eee)', textAlign: 'left', cursor: 'pointer' } },
        h('div', { style: { fontWeight: 600, overflowWrap: 'anywhere' } }, `${row.path} · 第 ${row.line} 行`),
        h('div', { style: { marginTop: 4, color: 'var(--dsw-alias-label-secondary, #aaa)', font: '12px/18px ui-monospace, SFMono-Regular, Consolas, monospace', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, highlightPreview(row.preview, query, caseSensitive, wholeWord)))) : h('div', { style: { padding: 12, color: 'var(--dsw-alias-label-tertiary, #999)', textAlign: 'center' } }, query.trim() ? '没有匹配结果。' : '输入关键词开始搜索。')));
  }
  function Owner({ sessionId, inputActions }) {
    useLayoutEffect(() => {
      if (!sessionId || !inputActions) return;
      const owner = { actions: inputActions }; owners.set(sessionId, owner);
      return () => { if (owners.get(sessionId) === owner) owners.delete(sessionId); if (target?.owner === owner && state.open) close(); };
    }, [sessionId, inputActions]);
    return null;
  }
  function Dialog() {
    const s = useSyncExternalStore(subscribe, () => state, () => state);
    const queryRef = useRef(null), panelRef = useRef(null), rowRef = useRef(null);
    useEffect(() => { if (s.open) queryRef.current?.focus(); }, [s.open]);
    useEffect(() => { rowRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [s.selected, s.matches]);
    if (!s.open) return null;
    const update = (key, value) => { const next = { ...state, [key]: value }; publish({ [key]: value }); schedule(next.query, next.include, next.caseSensitive, next.wholeWord); };
    const keyDown = e => {
      if (e.isComposing || e.nativeEvent?.isComposing) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (state.open) close(); return; }
      if (!state.open) return;
      if (e.target?.tagName === 'BUTTON') return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); if (s.matches.length) publish({ selected: (s.selected + (e.key === 'ArrowDown' ? 1 : -1) + s.matches.length) % s.matches.length }); return; }
      if (e.key === 'Enter' && s.matches.length) { e.preventDefault(); e.stopPropagation(); select(s.selected); }
    };
      const styles = `
       .dsh-content-search-dialog { width: min(920px, calc(100vw - 48px)); height: min(720px, calc(100dvh - 48px)); max-height: calc(100dvh - 48px); padding: 0; gap: 0; }
       .dsh-cs-panel { box-sizing: border-box; display: flex; flex-direction: column; min-width: 0; min-height: 0; width: 100%; height: 100%; color: var(--dsw-alias-label-primary, #eee); font-size: 14px; }
       .dsh-cs-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 22px 24px 14px; }
       .dsh-cs-title { display: block; font-size: 18px; line-height: 26px; font-weight: 600; }
       .dsh-cs-subtitle { margin-top: 3px; color: var(--dsw-alias-label-secondary, #999); font-size: 12px; line-height: 18px; }
       .dsh-cs-close { width: 32px; height: 32px; flex: none; border: 0; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary, #999); font: inherit; font-size: 23px; line-height: 1; cursor: pointer; }
       .dsh-cs-close:hover { background: var(--dsw-alias-interactive-bg-hover, #555); }
       .dsh-cs-fields { display: grid; grid-template-columns: minmax(0, 1fr) minmax(190px, 30%); gap: 12px; padding: 0 24px 12px; }
       .dsh-cs-label { display: flex; flex-direction: column; gap: 6px; min-width: 0; color: var(--dsw-alias-label-secondary, #999); font-size: 12px; }
       .dsh-cs-input { box-sizing: border-box; width: 100%; height: 42px; min-width: 0; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l2, #777); border-radius: 9px; background: var(--dsw-alias-bg-module-platform, #242424); color: var(--dsw-alias-label-primary, #eee); font: inherit; font-size: 14px; outline: none; }
       .dsh-cs-input:focus { border-color: var(--dsw-alias-accent, #4a86e8); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-accent, #4a86e8) 22%, transparent); }
       .dsh-cs-options { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
       .dsh-cs-check { display: inline-flex; align-items: center; gap: 7px; color: var(--dsw-alias-label-secondary, #999); font-size: 12px; cursor: pointer; user-select: none; }
       .dsh-cs-check input { width: 14px; height: 14px; margin: 0; accent-color: var(--dsw-alias-accent, #4a86e8); }
       .dsh-cs-summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 24px; border-top: 1px solid var(--dsw-alias-border-l3, #444); border-bottom: 1px solid var(--dsw-alias-border-l3, #444); font-size: 12px; color: var(--dsw-alias-label-secondary, #999); }
       .dsh-cs-status-error { color: var(--dsw-alias-state-error, #ef7777); }
       .dsh-cs-warning { padding: 9px 24px; color: var(--dsw-alias-label-secondary, #aaa); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
       .dsh-cs-results { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 8px 14px; }
       .dsh-cs-empty { display: grid; min-height: 180px; height: 100%; place-content: center; text-align: center; color: var(--dsw-alias-label-tertiary, #999); line-height: 22px; }
       .dsh-cs-results:focus-visible { outline: 2px solid var(--dsw-alias-accent, #4a86e8); outline-offset: -2px; }
       .dsh-cs-result { box-sizing: border-box; padding: 10px 12px; border: 1px solid transparent; border-radius: 9px; cursor: pointer; }
       .dsh-cs-result[aria-selected="true"] { background: var(--dsw-alias-interactive-bg-hover, #555); border-color: var(--dsw-alias-border-l2, #777); }
       .dsh-cs-path { display: flex; align-items: baseline; gap: 8px; min-width: 0; line-height: 20px; }
       .dsh-cs-name { flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
       .dsh-cs-dir { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary, #999); font-size: 12px; }
       .dsh-cs-line { margin-left: auto; flex: none; color: var(--dsw-alias-label-secondary, #999); font-size: 12px; font-variant-numeric: tabular-nums; }
       .dsh-cs-preview { margin-top: 5px; overflow: hidden; color: var(--dsw-alias-label-secondary, #aaa); font: 12px/19px ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
       .dsh-cs-highlight { background: #e8ad3d; color: #1d1b16; border-radius: 3px; padding: 0 1px; }
       .dsh-cs-footer { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; padding: 12px 24px; border-top: 1px solid var(--dsw-alias-border-l3, #444); color: var(--dsw-alias-label-secondary, #999); font-size: 12px; }
       .dsh-cs-footer kbd { font: inherit; border: 1px solid var(--dsw-alias-border-l2, #777); border-radius: 4px; padding: 1px 5px; margin-right: 4px; }
       @media (max-width: 600px) { .dsh-content-search-dialog { width: calc(100vw - 24px); height: min(720px, calc(100dvh - 24px)); max-height: calc(100dvh - 24px); } .dsh-cs-header { padding: 16px 16px 12px; } .dsh-cs-fields { grid-template-columns: 1fr; gap: 10px; padding: 0 16px 12px; } .dsh-cs-summary, .dsh-cs-warning, .dsh-cs-footer { padding-left: 16px; padding-right: 16px; } }
      `;
     const status = s.status === 'error' ? s.message : s.status === 'loading' || s.status === 'waiting' ? `正在搜索…${s.matches.length ? ` 已找到 ${s.matches.length} 条` : ''}${s.stats ? `（已检查 ${s.stats.files} 个文件）` : ''}` : s.status === 'done' && !s.matches.length ? '没有匹配结果。' : s.status === 'idle' ? '输入内容开始搜索。' : `${s.matches.length} 条匹配${s.truncated ? '（结果不完整）' : ''}`;

    return h(Modal, { open: true, onClose: close, title: '搜索工作区内容', headless: true, shortcutModal: 'content-search', className: 'dsh-content-search-dialog' },
      h('section', { ref: panelRef, className: 'dsh-cs-panel', 'aria-labelledby': 'dsh-content-search-title', onKeyDown: keyDown },
        h('style', null, styles),
        h('header', { className: 'dsh-cs-header' },
          h('div', null, h('strong', { id: 'dsh-content-search-title', className: 'dsh-cs-title' }, '搜索工作区内容'), h('div', { className: 'dsh-cs-subtitle' }, '查找文件内容并将选中文件插入当前对话')),
          h('button', { type: 'button', onClick: close, 'aria-label': '关闭搜索', className: 'dsh-cs-close' }, '×')),
        h('div', { className: 'dsh-cs-fields' },
          h('label', { className: 'dsh-cs-label' }, '搜索内容', h('input', { ref: queryRef, className: 'dsh-cs-input', 'data-dsh-content-search-query': '', 'aria-label': '搜索内容', 'aria-controls': 'dsh-cs-results', 'aria-activedescendant': s.matches.length ? `dsh-cs-option-${s.selected}` : undefined, placeholder: '输入关键词，默认不区分大小写', value: s.query, onChange: e => update('query', e.target.value), maxLength: 1024 })),
          h('label', { className: 'dsh-cs-label' }, '包含文件', h('input', { className: 'dsh-cs-input', 'aria-label': '包含文件 glob', 'aria-controls': 'dsh-cs-results', 'aria-activedescendant': s.matches.length ? `dsh-cs-option-${s.selected}` : undefined, placeholder: '例如 *.ts, *.md', value: s.include, onChange: e => update('include', e.target.value), maxLength: 1024 }))),
        h('div', { className: 'dsh-cs-summary' }, h('div', { role: 'status', 'aria-live': 'polite', className: s.status === 'error' ? 'dsh-cs-status-error' : '' }, status), h('div', { className: 'dsh-cs-options' }, h('label', { className: 'dsh-cs-check' }, h('input', { type: 'checkbox', checked: s.caseSensitive, onChange: e => update('caseSensitive', e.target.checked), 'aria-label': '区分大小写' }), '区分大小写'), h('label', { className: 'dsh-cs-check', title: '仅匹配完整单词，不匹配其他单词中的片段' }, h('input', { type: 'checkbox', checked: s.wholeWord, onChange: e => update('wholeWord', e.target.checked), 'aria-label': '全词匹配' }), '全词匹配')), h('span', null, '范围：当前会话工作区')),
        s.warnings.length ? h('div', { className: 'dsh-cs-warning' }, '部分内容未搜索：', s.warnings.map(warningLabel).join('；')) : null,
        h('div', { id: 'dsh-cs-results', className: 'dsh-cs-results', role: 'listbox', 'aria-label': '搜索结果' },
          s.matches.length ? s.matches.map((row, i) => {
            const slash = row.path.lastIndexOf('/');
            const name = slash < 0 ? row.path : row.path.slice(slash + 1);
            const dir = slash < 0 ? '' : row.path.slice(0, slash + 1);
            return h('div', { id: `dsh-cs-option-${i}`, key: `${row.path}:${row.line}:${i}`, className: 'dsh-cs-result', role: 'option', 'aria-label': `${row.path} 第 ${row.line} 行：${row.preview}`, 'aria-selected': i === s.selected, ref: i === s.selected ? rowRef : null, onMouseEnter: () => publish({ selected: i }), onMouseDown: e => e.preventDefault(), onClick: () => select(i) },
              h('div', { className: 'dsh-cs-path', title: row.path }, h('span', { className: 'dsh-cs-name' }, name), h('span', { className: 'dsh-cs-dir' }, dir), h('span', { className: 'dsh-cs-line' }, `第 ${row.line} 行`)),
              h('div', { className: 'dsh-cs-preview' }, highlightPreview(row.preview, s.query, s.caseSensitive, s.wholeWord)));
          }) : h('div', { className: 'dsh-cs-empty' }, s.status === 'loading' || s.status === 'waiting' ? '正在查找匹配内容…' : s.status === 'done' ? '试试其他关键词或文件筛选条件' : s.status === 'error' ? '请检查搜索条件后重试' : '输入关键词开始搜索', h('div', null, '支持 *.js、*.md 等文件筛选'))),
        h('footer', { className: 'dsh-cs-footer' }, h('span', null, h('kbd', null, '↑↓'), '选择结果'), h('span', null, h('kbd', null, 'Enter'), '插入文件引用'), h('span', null, h('kbd', null, 'Esc'), '关闭'))));
  }
  ctx.effect(() => {
    const sidebar = ctx.get?.('betterSidebar') ?? ctx.betterSidebar;
    if (!sidebar || typeof sidebar.registerTab !== 'function') return;
    return sidebar.registerTab({
      id: 'dsh-content-search:search',
      title: '内容搜索',
      description: '搜索当前会话工作区文件内容并插入文件引用',
      order: 70,
      single: true,
      component: props => h(SidebarSearch, { scope: props.scope }),
    });
  }, 'content-search: better-sidebar tab registration');
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'content-search.owner' }, Owner));
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'content-search.dialog' }, Dialog));
  ctx.effect(() => {
    // DSH Desktop intercepts catalog shortcuts before local editor handlers.
    // Handle this as a local DOM key instead, so sidebar editors still receive Mod+F.
    const onKey = event => {
      if (!active || state.open || event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || event.altKey || event.shiftKey || event.ctrlKey === event.metaKey || event.code !== 'KeyF' || event.getModifierState?.('AltGraph')) return;
      const target = event.target;
      if (!(target instanceof Element) || !target.matches('[data-composer-input][contenteditable="true"]') || document.activeElement !== target) return;
      const current = currentId();
      const conversation = target.closest('[data-conversation-content][data-conversation-session]');
      if (!current || conversation?.getAttribute('data-conversation-session') !== current || !owners.has(current) || !ctx.sessions.binding(current)) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      open();
    };
    const off = ctx.uiSession.adapter.current.subscribe(() => { if (state.open && target && !valid()) close(); });
    window.addEventListener('keydown', onKey, true);
    return () => { active = false; cancel(); window.removeEventListener('keydown', onKey, true); off(); owners.clear(); listeners.clear(); };
  }, 'content-search: composer-local keyboard and session lifetime');
};
