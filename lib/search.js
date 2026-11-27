// Browser-side search over the installed DSH workspaceFiles Remote. No direct
// filesystem or subprocess access: every operation is authorized by the Host.
const LIMIT = Object.freeze({ directories: 30000, entries: 200000, files: 20000, pages: 80000, matches: 500, fileBytes: 262144, lineChars: 500, pageLines: 500, timeoutMs: 120000, concurrency: 8 });
const EXCLUDED = new Set(['.git', '.hg', '.svn', 'node_modules', 'build', 'dist', 'coverage', '.next', '.cache']);

function abortError(signal) {
  if (signal.aborted) throw signal.reason ?? new DOMException('Search cancelled', 'AbortError');
}
function unwrap(result) {
  if (!result || typeof result.ok !== 'boolean') throw new Error('Invalid workspaceFiles response');
  if (!result.ok) throw result.error;
  return result.value;
}
function segmentMatches(pattern, value) {
  let p = 0, v = 0, star = -1, mark = 0;
  while (v < value.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === value[v])) { p++; v++; }
    else if (pattern[p] === '*') { star = p++; mark = v; }
    else if (star >= 0) { p = star + 1; v = ++mark; }
    else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}
function previewMatch(text, index, length) {
  if (text.length <= LIMIT.lineChars) return text;
  const context = Math.max(0, Math.floor((LIMIT.lineChars - Math.min(length, LIMIT.lineChars)) / 2));
  const start = Math.min(Math.max(0, index - context), text.length - LIMIT.lineChars);
  const end = start + LIMIT.lineChars;
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}
function originalIndex(text, foldedIndex, end = false) {
  let original = 0, folded = 0;
  for (const char of text) {
    const next = folded + char.toLowerCase().length;
    if (foldedIndex < next) return original + (end ? char.length : 0);
    folded = next;
    original += char.length;
  }
  return original;
}
const WORD_CHAR = /[\p{L}\p{M}\p{N}_]/u;
function previousChar(text, index) {
  if (index <= 0) return '';
  const code = text.codePointAt(index - 1);
  return String.fromCodePoint(code >= 0xDC00 && code <= 0xDFFF && index > 1 ? text.codePointAt(index - 2) : code);
}
function nextChar(text, index) {
  return index < text.length ? String.fromCodePoint(text.codePointAt(index)) : '';
}
function findMatch(text, needle, caseSensitive, wholeWord) {
  const haystack = caseSensitive ? text : text.toLowerCase();
  const startsWord = WORD_CHAR.test(nextChar(needle, 0));
  const endsWord = WORD_CHAR.test(previousChar(needle, needle.length));
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    const end = index + needle.length;
    if ((!wholeWord || !startsWord || !WORD_CHAR.test(previousChar(haystack, index))) &&
        (!wholeWord || !endsWord || !WORD_CHAR.test(nextChar(haystack, end)))) return index;
    index = haystack.indexOf(needle, index + 1);
  }
  return -1;
}
function compileIncludes(input) {
  if (input === undefined || input === '') return [];
  if (typeof input !== 'string' || input.length > 1024) throw new Error('include must be a comma-separated glob string of at most 1024 characters');
  const patterns = input.split(',').map(p => p.trim()).filter(Boolean);
  if (patterns.length > 20) throw new Error('at most 20 include patterns are supported');
  return patterns.map(p => {
    if (p.length > 256 || p.includes('\\') || p.startsWith('/') || p.split('/').some(s => !s || s === '.' || s === '..') || /[\[\]{}\0]/.test(p)) throw new Error('Unsupported include glob');
    const parts = p.split('/');
    if (parts.length > 32) throw new Error('include glob has too many segments');
    return { parts, basename: parts.length === 1 };
  });
}
function pathMatches(path, patterns) {
  if (!patterns.length) return true;
  const parts = path.split('/');
  return patterns.some(({ parts: pattern, basename }) => {
    if (basename) return segmentMatches(pattern[0], parts[parts.length - 1]);
    let states = new Set([0]);
    const close = set => { for (let i = 0; i < pattern.length; i++) if (set.has(i) && pattern[i] === '**') set.add(i + 1); return set; };
    close(states);
    for (const part of parts) {
      const next = new Set();
      for (const i of states) {
        if (pattern[i] === '**') next.add(i);
        else if (i < pattern.length && segmentMatches(pattern[i], part)) next.add(i + 1);
      }
      states = close(next);
    }
    return states.has(pattern.length);
  });
}

// Observe every task even after timeout; a Host implementation may ignore abort.
function tracked(promise) {
  const task = { done: false };
  task.promise = promise.then(value => { task.done = true; task.value = value; }, error => { task.done = true; task.error = error; });
  return task;
}
function waitFor(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
// All list and read RPCs share the same bounded pool.
function remoteGate(signal) {
  let active = 0;
  const queue = [];
  function pump() {
    while (!signal.aborted && active < LIMIT.concurrency && queue.length) {
      const { run, resolve, reject } = queue.shift();
      active++;
      Promise.resolve().then(() => { abortError(signal); return run(); }).then(resolve, reject).finally(() => { active--; pump(); });
    }
  }
  signal.addEventListener('abort', () => { for (const item of queue.splice(0)) item.reject(signal.reason); }, { once: true });
  return run => {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => { queue.push({ run, resolve, reject }); pump(); });
  };
}

/**
 * Search the Session's original workspace root through workspaceFiles. Files
 * are published only once fully read and in deterministic traversal order.
 * External cancellation rejects; timeout returns completed results with warning.
 */
export async function searchWorkspace(remote, sessionId, options, signal, onProgress) {
  if (!remote?.workspaceFiles || typeof remote.workspaceFiles.list !== 'function' || typeof remote.workspaceFiles.read !== 'function') throw new Error('workspaceFiles Remote unavailable');
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId is required');
  if (!options || typeof options.query !== 'string' || !options.query || options.query.length > 1024 || /[\r\n\0]/.test(options.query)) throw new Error('query must be a non-empty single line of at most 1024 characters');
  if (options.caseSensitive !== undefined && typeof options.caseSensitive !== 'boolean') throw new Error('caseSensitive must be boolean');
  if (options.wholeWord !== undefined && typeof options.wholeWord !== 'boolean') throw new Error('wholeWord must be boolean');
  const patterns = compileIncludes(options.include);
  const needle = options.caseSensitive ? options.query : options.query.toLowerCase();
  const timeout = new AbortController(), shutdown = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error('Search timed out')), LIMIT.timeoutMs);
  const control = AbortSignal.any([...(signal ? [signal] : []), timeout.signal, shutdown.signal]);
  const invoke = remoteGate(control);
  const matches = [], warnings = new Set(), stats = { directories: 0, files: 0, pages: 0 };
  let entries = 0, pageLimit = false;
  const warn = message => warnings.add(message);
  const result = () => ({ matches: matches.slice(), truncated: warnings.size > 0, warnings: [...warnings], stats: { ...stats } });
  let lastProgress = -Infinity;
  const report = () => {
    const now = Date.now();
    if (typeof onProgress === 'function' && !control.aborted && now - lastProgress >= 200) {
      lastProgress = now;
      onProgress(result());
    }
  };
  const dirs = [{ path: '.' }];
  let dirIndex = 0, scheduled = 0;
  function prefetchDirs() {
    while (scheduled < dirs.length && scheduled < dirIndex + LIMIT.concurrency) {
      const dir = dirs[scheduled++];
      dir.task = tracked(invoke(() => remote.workspaceFiles.list(sessionId, dir.path, control)).then(unwrap));
    }
  }
  async function readFile(file) {
    const fileWarnings = new Set(), found = [];
    const fileWarn = message => fileWarnings.add(message);
    if (typeof file.size === 'number' && file.size > LIMIT.fileBytes) {
      fileWarn('Some files exceeded the size limit');
      return { found, warnings: fileWarnings };
    }
    let offset = 1, version, consumedBytes = 0, complete = false, omitted = false;
    try {
      while (!complete) {
        abortError(control);
        if (stats.pages >= LIMIT.pages) { pageLimit = true; fileWarn(`Page limit reached (${LIMIT.pages})`); break; }
        stats.pages++;
        const page = unwrap(await invoke(() => remote.workspaceFiles.read(sessionId, file.path, { offset, limit: LIMIT.pageLines }, control)));
        abortError(control);
        if (!page || typeof page.text !== 'string' || !Number.isSafeInteger(page.lines) || page.lines < 0 || page.lines > LIMIT.pageLines || typeof page.eof !== 'boolean') throw new Error('Invalid workspace file page');
        consumedBytes += new TextEncoder().encode(page.text).length + Math.max(0, page.lines - 1);
        if ((typeof page.bytes === 'number' && page.bytes > LIMIT.fileBytes) || consumedBytes > LIMIT.fileBytes) { fileWarn('Some files exceeded the size limit'); break; }
        if (version !== undefined && page.version !== version) { fileWarn('Some files changed during search'); break; }
        version = page.version;
        const lines = page.lines ? page.text.split('\n') : [];
        if (lines.length !== page.lines) throw new Error('Invalid workspace file line count');
        for (let i = 0; i < lines.length; i++) {
          const text = lines[i];
          const index = findMatch(text, needle, !!options.caseSensitive, !!options.wholeWord);
          if (index < 0) continue;
          if (found.length >= LIMIT.matches) { omitted = true; continue; }
          const start = options.caseSensitive ? index : originalIndex(text, index);
          const end = options.caseSensitive ? index + needle.length : originalIndex(text, index + needle.length - 1, true);
          found.push({ path: file.path, line: offset + i, preview: previewMatch(text, start, end - start) });
        }
        complete = page.eof;
        if (!complete && page.lines === 0) throw new Error('Invalid empty non-final page');
        offset += page.lines;
      }
    } catch (error) {
      abortError(control);
      if (error?.code === 'workspace-file/not-text') fileWarn('Some binary or non-UTF-8 files were skipped');
      else if (error?.code === 'workspace-file/too-large') fileWarn('Some files exceeded the size limit');
      else fileWarn('Some files could not be read');
    }
    return { found: complete ? found : [], warnings: fileWarnings, omitted };
  }
  function commitFile(task) {
    if (task.error) throw task.error;
    const { found, warnings: fileWarnings, omitted } = task.value;
    for (const warning of fileWarnings) warn(warning);
    const available = LIMIT.matches - matches.length;
    matches.push(...found.slice(0, available));
    if (omitted || found.length > available || matches.length >= LIMIT.matches) warn('Match limit reached');
    report();
  }
  let pendingFiles = [];
  try {
    abortError(control);
    prefetchDirs();
    while (dirIndex < dirs.length && matches.length < LIMIT.matches && !pageLimit) {
      const dir = dirs[dirIndex++];
      prefetchDirs();
      await waitFor(dir.task.promise, control);
      abortError(control);
      if (dir.task.error) { if (dir.path === '.') throw dir.task.error; warn('Some directories could not be listed'); continue; }
      const listing = dir.task.value;
      stats.directories++;
      if (!listing || !Array.isArray(listing.entries)) throw new Error('Invalid workspace directory listing');
      if (listing.truncated) warn('Some directory entries were omitted by the Host');
      const files = [];
      let entryLimit = false;
      for (const entry of listing.entries) {
        if (entries >= LIMIT.entries) { warn(`Entry limit reached (${LIMIT.entries})`); entryLimit = true; break; }
        entries++;
        if (!entry || typeof entry.name !== 'string' || !entry.name || entry.name === '.' || entry.name === '..' || /[\\/\0]/.test(entry.name)) { warn('Invalid directory entry skipped'); continue; }
        const path = dir.path === '.' ? entry.name : `${dir.path}/${entry.name}`;
        if (entry.type === 'directory') {
          if (!EXCLUDED.has(entry.name.toLowerCase())) {
            if (dirs.length < LIMIT.directories) dirs.push({ path });
            else warn(`Directory limit reached (${LIMIT.directories})`);
          }
        } else if (entry.type === 'file' && pathMatches(path, patterns)) files.push({ path, size: entry.size });
      }
      prefetchDirs();
      let fileIndex = 0, fileLimit = false;
      const fill = () => {
        while (pendingFiles.length < LIMIT.concurrency && fileIndex < files.length && !pageLimit) {
          if (stats.files >= LIMIT.files) { warn(`File limit reached (${LIMIT.files})`); fileLimit = true; break; }
          stats.files++;
          pendingFiles.push(tracked(readFile(files[fileIndex++])));
        }
      };
      fill();
      while (pendingFiles.length && matches.length < LIMIT.matches) {
        const next = pendingFiles[0];
        await waitFor(next.promise, control);
        abortError(control);
        pendingFiles.shift();
        commitFile(next);
        fill();
      }
      if (entryLimit || fileLimit) break;
    }
    abortError(control);
    if (pageLimit) warn(`Page limit reached (${LIMIT.pages})`);
    return result();
  } catch (error) {
    if (signal?.aborted) abortError(signal);
    if (!timeout.signal.aborted) throw error;
    for (const task of pendingFiles) {
      if (task.done && !task.error && matches.length < LIMIT.matches) commitFile(task);
    }
    if (pageLimit) warn(`Page limit reached (${LIMIT.pages})`);
    warn(`Search timed out after ${LIMIT.timeoutMs} ms`);
    return result();
  } finally {
    clearTimeout(timer);
    shutdown.abort(new Error('Search finished'));
  }
}

export { LIMIT as SEARCH_LIMITS };
