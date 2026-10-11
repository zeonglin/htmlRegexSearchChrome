const regexInput = document.getElementById('regex');
const refreshBtn = document.getElementById('refresh');
const clearBtn = document.getElementById('clear');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const shortCtxEl = document.getElementById('short-ctx');
const caseEl = document.getElementById('ignore-case');
const historySel = document.getElementById('history');
const copySelBtn = document.getElementById('copy-selected');
const copyMatchedBtn = document.getElementById('copy-matched');
const copyAllBtn = document.getElementById('copy-all');

let lastMatches = [];
let history = [];
let selectedId = -1;
let displayed = []; // parallel to lastMatches: the full text each row shows

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

// Regex flags: "g" always (needed for multiple matches), "i" when Aa is checked.
function flags() {
  return 'g' + (caseEl.checked ? 'i' : '');
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

// Content scripts only inject on page load, so tabs opened before the
// (re)install have none. Inject on demand when the first message finds no receiver.
async function ensureContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content.js'],
  });
}

async function sendToContent(message) {
  const tabId = await activeTabId();
  if (tabId === undefined) return { ok: false, error: 'No active tab' };
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    // No receiving end: content script not present in this tab yet.
    try {
      await ensureContentScript(tabId);
    } catch (e2) {
      return { ok: false, error: `Cannot access this page (${e2.message})` };
    }
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch {
      return { ok: false, error: 'No response from page — try reloading it' };
    }
  }
}

async function clearAll() {
  lastMatches = [];
  renderResults(lastMatches);
  const res = await sendToContent({ type: 'hrx-clear' });
  setStatus(res?.ok ? 'Cleared' : (res?.error || 'Failed'), !res?.ok);
}

async function refresh() {
  const regex = regexInput.value;
  if (!regex) {
    return clearAll();
  }
  setStatus('Searching…');
  const res = await sendToContent({ type: 'hrx-refresh', regex, flags: flags() });
  if (!res) return setStatus('No response', true);
  if (!res.ok) {
    lastMatches = [];
    renderResults(lastMatches);
    return setStatus(res.error, true);
  }
  setStatus(`${res.count} match${res.count === 1 ? '' : 's'}`);
  lastMatches = res.matches || [];
  renderResults(lastMatches);
  saveHistory(regex, flags());
}

// ---- Regex history (global, most recent first, capped) ------------------------

const HISTORY_KEY = 'hrxHistory';
const HISTORY_CAP = 15;

async function loadHistory() {
  const saved = await chrome.storage.local.get(HISTORY_KEY);
  history = saved[HISTORY_KEY] || [];
  renderHistory();
}

function renderHistory() {
  const current = regexInput.value;
  historySel.innerHTML = '';
  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = 'saved regexes…';
  historySel.appendChild(ph);
  for (const entry of history) {
    const opt = document.createElement('option');
    opt.value = entry.regex;
    opt.textContent = entry.regex + (entry.flags?.includes('i') ? '  (i)' : '');
    historySel.appendChild(opt);
  }
  const exists = [...historySel.options].some((o) => o.value === current && current !== '');
  historySel.value = exists ? current : '';
}

async function saveHistory(regex, fl) {
  history = history.filter((e) => e.regex !== regex || e.flags !== fl);
  history.unshift({ regex, flags: fl });
  history = history.slice(0, HISTORY_CAP);
  await chrome.storage.local.set({ [HISTORY_KEY]: history });
  renderHistory();
}

// ---- Results list -------------------------------------------------------------

// "Short context" mode: 2 words before the match + match + 2 words after.
function shortWindow(ctx, text) {
  const at = ctx.indexOf(text);
  if (at < 0) return ctx;
  const before = ctx.slice(0, at).trim().split(/\s+/).slice(-2).join(' ');
  const after = ctx.slice(at + text.length).trim().split(/\s+/).slice(0, 2).join(' ');
  return [before, text, after].filter(Boolean).join(' ');
}

function renderResults(matches) {
  resultsEl.innerHTML = '';
  selectedId = -1;
  displayed = [];
  copySelBtn.hidden = true;
  copyMatchedBtn.hidden = true;
  const short = shortCtxEl.checked;
  for (const m of matches) {
    const item = document.createElement('button');
    item.className = 'result';
    item.dataset.id = String(m.id);

    const rid = document.createElement('span');
    rid.className = 'rid';
    rid.textContent = `#${m.id + 1}`;
    item.appendChild(rid);

    const body = document.createElement('span');
    body.className = 'body';
    // The stored match may contain raw whitespace; the context is normalized,
    // so look the match up with a normalized copy.
    const text = m.text ? m.text.replace(/\s+/g, ' ') : '';
    const ctx = (short && text) ? shortWindow(m.context || '', text) : (m.context || '');
    const at = text ? ctx.indexOf(text) : -1;
    if (text && at >= 0) {
      body.appendChild(document.createTextNode(ctx.slice(0, at)));
      const mark = document.createElement('mark');
      mark.textContent = text;
      body.appendChild(mark);
      body.appendChild(document.createTextNode(ctx.slice(at + text.length)));
    } else {
      body.textContent = text ? ctx : '(empty match)';
    }
    item.appendChild(body);
    displayed.push(body.textContent);

    item.addEventListener('click', () => {
      for (const el of resultsEl.children) el.classList.remove('active');
      item.classList.add('active');
      selectedId = m.id;
      copySelBtn.hidden = false;
      copyMatchedBtn.hidden = false;
      sendToContent({ type: 'hrx-scroll', id: Number(item.dataset.id) });
    });
    resultsEl.appendChild(item);
  }
}

// ---- Copy helpers -------------------------------------------------------------

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for environments where the Clipboard API is unavailable.
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    return ok;
  }
}

function flash(btn, original) {
  btn.textContent = '✓';
  setTimeout(() => { btn.textContent = original; }, 1200);
}

// ---- Wiring -------------------------------------------------------------------

refreshBtn.addEventListener('click', refresh);
clearBtn.addEventListener('click', clearAll);
regexInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') refresh();
});
caseEl.addEventListener('change', refresh); // flags affect the search itself
shortCtxEl.addEventListener('change', () => renderResults(lastMatches));
historySel.addEventListener('change', () => {
  if (historySel.value) {
    regexInput.value = historySel.value;
    refresh();
  }
});

copySelBtn.addEventListener('click', async () => {
  const text = displayed[selectedId] ?? '';
  if (!text) return;
  if (await copyText(text)) flash(copySelBtn, 'copy');
});

copyMatchedBtn.addEventListener('click', async () => {
  const m = lastMatches.find((x) => x.id === selectedId);
  if (!m) return;
  if (await copyText(m.text)) flash(copyMatchedBtn, 'copy matched');
});

copyAllBtn.addEventListener('click', async () => {
  if (!displayed.length) return;
  if (await copyText(displayed.join('\n----\n'))) {
    flash(copyAllBtn, 'copy all');
  }
});

loadHistory();
setStatus('Type a regex (or pick a saved one) and hit refresh');
