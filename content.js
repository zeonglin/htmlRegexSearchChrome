// Content script: lives in the page, performs the actual search over the rendered DOM.

// Guard against double injection (manifest content_scripts + on-demand executeScript
// share this isolated world, so a window flag is visible to both copies).
if (window.__HRX_LOADED__) {
  throw new Error('hrx content script already loaded');
}
window.__HRX_LOADED__ = true;

const HIGHLIGHT_CLASS = 'hrx-match';
const ACTIVE_CLASS = 'hrx-match-active';

// One-time injected style so highlighting works on any page.
function ensureStyle() {
  if (document.getElementById('hrx-style')) return;
  const style = document.createElement('style');
  style.id = 'hrx-style';
  style.textContent = `
    .${HIGHLIGHT_CLASS} { background: #ffe94a; outline: 1px solid #e0c800; }
    .${ACTIVE_CLASS} { background: #ff9d00; outline: 2px solid #d96400; }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function isSearchableTextNode(node) {
  if (!node.nodeValue || !node.nodeValue.trim()) return false;
  const p = node.parentElement;
  if (!p) return false;
  const tag = p.tagName.toUpperCase();
  if (tag === 'SCRIPT' || tag === 'STYLE') return false;
  return true;
}

function iterTextNodes(root, cb) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return isSearchableTextNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  let n;
  while ((n = walker.nextNode())) cb(n);
}

// Remove our previous highlight spans, restoring plain text.
function clearHighlights() {
  const spans = document.querySelectorAll(`span.${HIGHLIGHT_CLASS}`);
  for (const span of spans) {
    const parent = span.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(span.textContent), span);
    parent.normalize(); // merge the text back with neighbors
  }
}

// For the results list: the text of the containing text node (whitespace-normalized).
function contextAround(node) {
  return node.nodeValue.replace(/\s+/g, ' ').trim();
}

// Phase 1: collect every match location on the pristine (unmutated) tree.
// Returns hits in document order: { node, index, text, context }.
function findMatches(re) {
  const hits = [];
  iterTextNodes(document.documentElement, (node) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(node.nodeValue)) !== null) {
      hits.push({
        node,
        index: m.index,
        text: m[0],
        context: contextAround(node),
      });
      if (m[0] === '') re.lastIndex++; // guard against zero-width matches
    }
  });
  return hits;
}

// Phase 2: wrap each collected hit in a highlight span.
// All hits on the same text node are contiguous (the walker visits each node once),
// so we process each node's run with a running cursor over the (now split) fragments.
function applyHighlights(re) {
  const hits = findMatches(re);
  const matches = [];

  let i = 0;
  while (i < hits.length) {
    const node = hits[i].node;
    let j = i;
    while (j < hits.length && hits[j].node === node) j++;

    let offset = 0; // consumed characters within the original node
    let cur = node; // text node holding [offset, end) of the original text

    for (let k = i; k < j; k++) {
      const h = hits[k];
      if (!cur || cur.nodeType !== Node.TEXT_NODE || !cur.isConnected) {
        cur = null;
        continue; // node was detached/destroyed by page JS; skip the rest
      }
      const start = h.index - offset;
      let piece = cur;
      if (start > 0) piece = cur.splitText(start);
      const len = h.text.length;
      if (len === 0) piece = piece.splitText(0);
      else if (len < piece.nodeValue.length) piece.splitText(len);

      const span = document.createElement('span');
      span.className = HIGHLIGHT_CLASS;
      span.dataset.hrxId = String(matches.length);
      span.textContent = piece.nodeValue; // === h.text
      piece.parentNode.replaceChild(span, piece);

      matches.push({ id: matches.length, text: h.text, context: h.context });
      offset = h.index + len;
      cur = span.nextSibling;
    }
    i = j;
  }
  return matches;
}

// The orange "active" flash on the current selection, cleared after a few seconds.
let activeTimer = null;
function clearActive() {
  if (activeTimer) {
    clearTimeout(activeTimer);
    activeTimer = null;
  }
  document.querySelectorAll(`span.${ACTIVE_CLASS}`).forEach((s) => s.classList.remove(ACTIVE_CLASS));
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'hrx-refresh') {
    let re;
    try {
      const fl = (msg.flags || 'g').includes('g') ? msg.flags : (msg.flags || '') + 'g';
      re = new RegExp(msg.regex, fl);
    } catch (e) {
      sendResponse({ ok: false, error: `Invalid regex: ${e.message}` });
      return;
    }
    ensureStyle();
    clearHighlights();
    clearActive();
    const matches = applyHighlights(re);
    sendResponse({ ok: true, count: matches.length, matches });
    return;
  }
  if (msg?.type === 'hrx-clear') {
    clearHighlights();
    clearActive();
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type === 'hrx-scroll' && Number.isInteger(msg.id)) {
    clearActive();
    const span = document.querySelector(`span[data-hrx-id="${msg.id}"]`);
    if (!span) {
      sendResponse({ ok: false, error: 'Match no longer in page — hit Refresh' });
      return;
    }
    span.scrollIntoView({ block: 'center', behavior: 'smooth' });
    span.classList.add(ACTIVE_CLASS);
    activeTimer = setTimeout(clearActive, 3000);
    sendResponse({ ok: true });
    return;
  }
});
