// ---------- wiki view: a card and its subtree read as ONE document ----------
// The third view over the same nodes (body.wiki hides the canvas, the document renders into
// #wikiDoc and its contents list into #wikiToc), aimed at reading a long note — a design doc, a
// spec — the way a wiki reads, rather than as boxes on a plane. Toggled by the toolbar button /
// the W key; the choice persists per device in outline.ts's VIEW_KEY, which the two alternative
// views share so they can't disagree about which one is on.
//
// ONE rule decides what a page is: A PAGE IS A NODE, AND ITS BODY IS THAT NODE'S WHOLE SUBTREE
// FLATTENED INTO A DOCUMENT. Heading level follows depth (page root → h1, its children → h2, …
// capped at h6), and section order is exactly the canvas order (rootsInOrder / orderedKids) — which
// is the point of the view: drag a card up its parent's stack and the section moves up the document.
//
// The view stays deliberately NARROW — it has four interactions and no more, so most of the app
// still has nothing to say about it:
//   · DOUBLE-CLICK a section to edit it, in place, as raw markdown. One textarea holding the whole
//     note — its `# ` heading line and its body together — because that is what the note IS on disk
//     (utils/frontmatter.ts joinHeading/splitHeading), exactly as the in-card editor holds it.
//   · A [[wikilink]] navigates within the document set — and one naming a card that DOESN'T EXIST
//     creates it, as a child of the section the link was written in, then opens it for editing. That
//     is how a wiki grows, and it means writing a link is enough to grow the outline too.
//   · The ↗ button in a heading hands that card back to the canvas, selected — read here, rearrange
//     there. It is a button rather than the heading itself so a stray click can't teleport you off
//     the page you're reading, now that clicking into text means editing it.
//   · The contents list and the crumb trail move between pages.
// Everything else — creating cards, deleting, colours, layout — stays on the canvas.
//
// Two things a card shows that a document shouldn't: a collapsed subtree is still READ here
// (mm_collapsed is a canvas fold, and a section vanishing from a document because it happens to be
// folded on the board would be a surprise), and annotations + query cards are skipped entirely —
// the first is canvas furniture pinned over its parent, the second a live search widget, and
// neither is prose.
import { state, setStatus, isAnnotation, isQueryCard, isLeafType, type MindNode } from '../core/state.js';
import { ui } from '../core/ui-state.js';
import { nodeLabel, childrenOf, ancestors, isLockedEffective, descendantCount, rootsInOrder, resolveWikilink } from '../utils/model.js';
import { orderedKids } from '../view/layout.js';
import { renderBodyHTML } from '../utils/markdown.js';
import { joinHeading, splitHeading } from '../utils/frontmatter.js';
import { scopeRootNode } from '../nav/scope.js';
import { scheduleUrlSync, syncUrl, updateDocumentTitle } from '../nav/url-state.js';
import { scheduleSave } from '../data/persistence.js';
import { hydrateImages } from './images.js';
import { createNode } from './crud.js';
import { setTypeOn } from './float-bar.js';
import { pasteUrlLink } from './inline-edit.js';
import { touch, commitStep } from './history.js';
import { outlineActive, setOutline, beforeOutlineOn, VIEW_KEY } from './outline.js';
import { selectNode, focusNode, remeasure } from '../main.js';
import { byId } from '../utils/dom.js';

const docEl = byId('wikiDoc');
const tocEl = byId('wikiToc');
const wikiBtn = byId<HTMLButtonElement>('wikiBtn');

// The node whose subtree is being read. Held as an id (nodes are re-minted on every disk reload)
// and re-validated on each render, so a page whose card was deleted underneath falls back rather
// than rendering an empty document.
let pageId: string | null = null;
let shownPageId: string | null = null;   // what the DOM currently holds — a rebuild of the SAME page keeps its scroll

// ---- mode toggle ----
export function wikiActive(): boolean { return document.body.classList.contains('wiki'); }
export function toggleWikiView(): void { setWiki(!wikiActive()); }
// `persist` records the choice as the user's own preference; forced switches (the outliner opening
// over us, a phone rotating into it) pass false so they don't overwrite what was picked elsewhere.
export function setWiki(on: boolean, persist = true): void {
  if (on === wikiActive()) return;
  if (on && document.body.classList.contains('sketching')) { setStatus('Leave sketch mode first (S)'); return; }
  if (on && outlineActive()) setOutline(false, false);   // one alternative view at a time
  document.body.classList.toggle('wiki', on);
  wikiBtn.classList.toggle('active', on);
  if (persist) { try { localStorage.setItem(VIEW_KEY, on ? 'wiki' : 'canvas'); } catch {} }
  if (on) { pageId = defaultPage(); renderWiki(); docEl.scrollTop = 0; }
  // back to the canvas: orient at whatever you were just reading, exactly as the outliner does
  else if (state.selId) focusNode(state.nodes.get(state.selId), true);
  scheduleUrlSync();
}
wikiBtn.onclick = toggleWikiView;
// Registered with the outliner rather than called from it — see beforeOutlineOn's comment there.
beforeOutlineOn(() => setWiki(false, false));

function wantWiki(): boolean {
  try { return localStorage.getItem(VIEW_KEY) === 'wiki'; } catch { return false; }
}
// Initial application at IMPORT time: the body class ONLY, never renderWiki — this module and
// main.ts are a cycle (selectNode/focusNode), so main is still mid-evaluation here and reaching
// into it throws. boot()'s first paintAll() renders the document (paintAll → renderWiki).
// The outline check is the phone case: outline.ts is imported first (main.ts) and FORCES its own
// mode by orientation there, so if it has already claimed the screen the saved 'wiki' doesn't apply.
if (wantWiki() && !document.body.classList.contains('outline')) {
  document.body.classList.add('wiki'); wikiBtn.classList.add('active');
}

// ---- which page ----
// Where the view opens: the frame you have open if you're inside one, else the ROOT of whatever is
// selected (its whole document, not the paragraph you happened to click), else the first root.
function defaultPage(): string | null {
  const open = scopeRootNode();
  if (open) return open.id;
  const sel = state.selId ? state.nodes.get(state.selId) : null;
  if (sel) return pageHolding(sel).id;
  return rootsInOrder()[0]?.id ?? null;
}
// The page a node BELONGS to: itself if it is one, else the nearest sub-page above it, else its
// root. Not the outermost root any more — with frames as boundaries, that would open the whole map's
// top document instead of the one the card is actually written in.
function pageHolding(n: MindNode): MindNode {
  if (isSubPage(n)) return n;
  let top = n;
  for (const a of ancestors(n)) { if (isSubPage(a)) return a; top = a; }
  return top;
}
// Is `id` part of the document currently on screen? Decides the ONE navigation rule shared by the
// contents list and by wikilinks: something inside this page SCROLLS, anything else BECOMES the page.
// "Inside" stops at the first sub-page: a node under a nested frame is a descendant of this page's
// root but belongs to a page of its own, and scrolling to a section that isn't rendered would do
// nothing at all.
function inPage(id: string): boolean {
  if (!pageId) return false;
  if (id === pageId) return true;
  const n = state.nodes.get(id);
  if (!n) return false;
  // A sub-page belongs to ITSELF, not to the document that links to it — it renders in its parent as
  // a card, never as a section, so "scroll to it here" has nothing to scroll to.
  if (isSubPage(n)) return false;
  for (const p of ancestors(n)) {
    if (p.id === pageId) return true;
    if (isSubPage(p)) return false;   // crossed into a nested page on the way up
  }
  return false;
}
function goTo(id: string): void {
  if (!state.nodes.has(id)) return;
  if (inPage(id)) { scrollToSection(id); return; }
  pageId = id;
  renderWiki();
  docEl.scrollTop = 0;
  // A page change is a NAVIGATION — the same kind of step selecting a card is on the canvas — so it
  // PUSHES a history entry and browser back/forward walk the pages you read. Camera/mode/scroll
  // changes keep replacing (scheduleUrlSync); only this and a canvas selection push.
  syncUrl();
  updateDocumentTitle();
}

// ---- the page, as the URL sees it ----
// The wiki page is what nav/url-state.ts puts in the hash's PATH while this view is active: in here
// the page is the identity of what you're looking at, and the selection isn't even on screen. Its
// FILE is the identity that survives a reload (ids are re-minted), exactly as for a selected card.
export function wikiPageNode(): MindNode | null {
  return pageId ? state.nodes.get(pageId) ?? null : null;
}
// Restore the page a hash names, WITHOUT writing history back out — applyUrlFromHash is already
// inside its own re-entrancy guard, and a push here would bury the entry being restored.
export function showWikiPage(file: string): void {
  const target = [...state.nodes.values()].find(n => n.file === file);
  if (!target || target.id === pageId) return;
  pageId = target.id;
  renderWiki();
  docEl.scrollTop = 0;
  updateDocumentTitle();   // the tab names the page, and a restored one is still a page change
}

// ---- where a page ENDS ----
// Containment does two jobs in this app — "is a section of" and "is a sub-page of" — and a document
// needs them told apart, or every descendant pours into one endless page. Every wiki draws that line
// explicitly (Confluence's page tree, Notion's sub-page BLOCK, MediaWiki's `/`, BookStack's
// book/chapter/page); none of them infers it from depth, and none of them inlines a child page.
//
// The line here is the KIND, because the canvas already draws it there: `canOpen` is frame-only and
// an open frame IS the canvas (nav/scope.ts), while "a card with children IS the outliner". So:
//
//     a FRAME is a sub-PAGE          ·          a CARD with children is SECTIONS
//
// which costs no new `mm_*` key and means the wiki's page tree and the canvas's frame tree are the
// same tree — opening a frame on the board and opening a page in here are one gesture.
export function isSubPage(n: MindNode): boolean { return n.type === 'frame'; }

// ---- the document ----
// A section per node, in canvas order. `level` is the heading level it would use; a node with no
// title of its own gets no heading at all (the app's UNTITLED card — see nodeLabel's contract), so
// a card holding one paragraph reads as one paragraph rather than as a stub section with a made-up
// name. Its children still nest under it, which is what makes breaking a note into paragraph cards
// and dragging them around read as a document.
//
// A sub-page is a `link` entry instead: the walk STOPS there and renders a card you click, at the
// position it holds in the order — so dragging still reorders what you see, and a page stays the
// length its author chose. That a container page with no prose of its own then shows nothing but a
// list of its children is Docusaurus's "generated index", falling out rather than special-cased.
interface Section { n: MindNode; level: number; link?: boolean }
function sectionsOf(root: MindNode): Section[] {
  const out: Section[] = [];
  const walk = (n: MindNode, depth: number): void => {
    if (isAnnotation(n) || isQueryCard(n)) return;
    // …the ROOT is always the page itself, however it's typed — a frame is a boundary for the
    // document ABOVE it, never for its own.
    if (depth > 0 && isSubPage(n)) { out.push({ n, level: Math.min(depth + 1, 6), link: true }); return; }
    out.push({ n, level: Math.min(depth + 1, 6) });
    for (const k of orderedKids(n, childrenOf(n.id))) walk(k, depth + 1);
  };
  walk(root, 0);
  return out;
}
function sectionEl(id: string): HTMLElement | null {
  return docEl.querySelector<HTMLElement>(`.wk-sec[data-id="${CSS.escape(id)}"]`);
}
// Scroll a section to the top of the document pane. Measured off the two rects rather than
// offsetTop: .wk-page isn't the scroll box's offset parent, so offsetTop would be relative to
// #wiki and quietly off by the pane's own inset.
function scrollToSection(id: string): void {
  const el = sectionEl(id);
  if (!el) return;
  docEl.scrollTop += el.getBoundingClientRect().top - docEl.getBoundingClientRect().top - 12;
  markHere();
}

// ---- the contents list ----
// The PAGE TREE — every page in the map — with the current page's own SECTIONS expanded beneath it.
// That pairing is what a wiki sidebar is (Confluence's page tree, BookStack's book tree): the tree
// tells you where you are among the documents, the sections tell you where you are within one, and
// no other page's innards are along for the ride.
//
// A page is a root or a frame (isSubPage). Sections are the titled cards inside the current page,
// found by the same walk the document uses, so the list and the prose can't disagree about what
// this page contains.
interface TocRow { n: MindNode; depth: number; section?: boolean }
function tocRows(): TocRow[] {
  const out: TocRow[] = [];
  // the pages BELOW `n`, without crossing another page on the way down
  const childPages = (n: MindNode): MindNode[] => {
    const found: MindNode[] = [];
    const dig = (m: MindNode): void => {
      for (const k of orderedKids(m, childrenOf(m.id))) {
        if (isAnnotation(k) || isQueryCard(k)) continue;
        if (isSubPage(k)) found.push(k);
        else dig(k);          // an ordinary section can still hold a sub-page under it
      }
    };
    dig(n);
    return found;
  };
  const walkPages = (n: MindNode, depth: number): void => {
    if (isAnnotation(n) || isQueryCard(n)) return;
    out.push({ n, depth });
    // the page you're READING opens up to show its own sections, between it and its child pages
    if (n.id === pageId) {
      for (const { n: sec, level, link } of sectionsOf(n)) {
        if (link || sec.id === n.id || !sec.title.trim()) continue;   // links are pages; the root is the row above
        out.push({ n: sec, depth: depth + level - 1, section: true });
      }
    }
    for (const c of childPages(n)) walkPages(c, depth + 1);
  };
  for (const r of rootsInOrder()) walkPages(r, 0);
  return out;
}

// A sub-page, as it appears INSIDE its parent: a link card carrying the name, an excerpt and how
// much is under it — Notion's sub-page line and Docusaurus's DocCardList. Never the content: that is
// the whole point of the boundary, and a listing is what every wiki shows here.
function subPageCard(n: MindNode): HTMLElement {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'wk-sub';
  card.dataset.id = n.id;
  const name = document.createElement('span');
  name.className = 'wk-sub-name';
  name.textContent = nodeLabel(n);
  card.append(name);
  // the first line of its note, if it has one — the "excerpt" a Children Display macro offers
  const lead = (n.body || '').split('\n').map(l => l.trim()).find(Boolean);
  if (lead) {
    const ex = document.createElement('span');
    ex.className = 'wk-sub-ex';
    ex.textContent = lead.replace(/^[#>\-*+\s]+/, '').slice(0, 140);
    card.append(ex);
  }
  const count = descendantCount(n.id);
  if (count) {
    const meta = document.createElement('span');
    meta.className = 'wk-sub-meta';
    meta.textContent = `${count} card${count === 1 ? '' : 's'}`;
    card.append(meta);
  }
  return card;
}

// ---- rendering ----
// Full rebuild, called from paintAll() so every mutation path keeps the document in sync for free
// (a no-op while another view is active). Scroll position survives a rebuild of the same page —
// autosave's paintAll must not throw you back to the top mid-read.
export function renderWiki(): void {
  if (!wikiActive()) return;
  if (editId) return;   // a rebuild would blow away the open textarea (autosave's paintAll lands here)
  if (!pageId || !state.nodes.has(pageId)) pageId = defaultPage();
  const page = pageId ? state.nodes.get(pageId) : null;
  const keepScroll = shownPageId === pageId ? docEl.scrollTop : 0;

  docEl.textContent = ''; tocEl.textContent = '';
  if (!page) {
    const none = document.createElement('div');
    none.className = 'wk-empty';
    none.textContent = state.nodes.size ? 'Nothing to read here yet' : 'This map is empty';
    docEl.append(none);
    shownPageId = null;
    return;
  }

  // contents
  for (const { n, depth, section } of tocRows()) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = section ? 'wk-row wk-row-sec' : 'wk-row';
    row.dataset.id = n.id;
    row.style.paddingLeft = `${10 + depth * 12}px`;
    row.textContent = nodeLabel(n);
    row.title = nodeLabel(n);
    row.classList.toggle('page', n.id === pageId);
    row.classList.toggle('inpage', !!section);
    tocEl.append(row);
  }

  // document
  const wrap = document.createElement('article');
  wrap.className = 'wk-page';
  const up = [...ancestors(page)].reverse();
  if (up.length) {
    const nav = document.createElement('nav');
    nav.className = 'wk-up';
    up.forEach((a, i) => {
      if (i) nav.append(Object.assign(document.createElement('span'), { className: 'wk-up-sep', textContent: '›' }));
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'wk-up-crumb'; b.dataset.id = a.id; b.textContent = nodeLabel(a);
      nav.append(b);
    });
    wrap.append(nav);
  }
  for (const { n, level, link } of sectionsOf(page)) {
    // a SUB-PAGE: a card you click, at the position it holds in the order — never its content
    if (link) { wrap.append(subPageCard(n)); continue; }
    const sec = document.createElement('section');
    sec.className = 'wk-sec';
    sec.dataset.id = n.id;
    if (n.title.trim()) {
      const h = document.createElement(`h${level}`);
      h.className = 'wk-h';
      h.textContent = n.title.trim();
      // …and, on a section that could BE one, the way to split it off (see promoteToPage)
      if (n.id !== page.id && n.type === 'card' && !state.readOnly && !isLockedEffective(n)) {
        const mk = document.createElement('button');
        mk.type = 'button'; mk.className = 'wk-mkpage';
        mk.textContent = 'Make a page';
        mk.title = 'Split this section off as a sub-page (turns the card into a frame)';
        h.append(mk);
      }
      const jump = document.createElement('button');
      jump.type = 'button'; jump.className = 'wk-jump';
      jump.textContent = '↗';
      jump.title = 'Show this card on the canvas';
      jump.setAttribute('aria-label', `Show “${n.title.trim()}” on the canvas`);
      h.append(jump);
      sec.append(h);
    }
    const body = document.createElement('div');
    body.className = 'wk-body';
    body.innerHTML = renderBodyHTML(n.body);
    hydrateImages(body);
    // a reading surface writes nothing: a task list renders as it stands, and can't be ticked here
    body.querySelectorAll<HTMLInputElement>('.taskbox').forEach(b => { b.disabled = true; });
    sec.append(body);
    wrap.append(sec);
  }
  docEl.append(wrap);
  shownPageId = pageId;
  docEl.scrollTop = keepScroll;
  markHere();
}

// The row for the section you're reading. Cheap enough to run straight off the scroll event (a
// document is tens of sections, not thousands) — no rAF, so it also behaves under a paused
// compositor.
function markHere(): void {
  const top = docEl.getBoundingClientRect().top + 80;
  let here: string | null = null;
  for (const sec of docEl.querySelectorAll<HTMLElement>('.wk-sec')) {
    if (sec.getBoundingClientRect().top <= top) here = sec.dataset.id ?? null;
    else break;
  }
  for (const row of tocEl.querySelectorAll<HTMLElement>('.wk-row'))
    row.classList.toggle('here', !!here && row.dataset.id === here);
}
docEl.addEventListener('scroll', markHere, { passive: true });

// ---- the two interactions ----
tocEl.addEventListener('click', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.wk-row');
  if (row?.dataset.id) goTo(row.dataset.id);
});
docEl.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  // a crumb widens the page back out to an ancestor
  const crumb = t.closest<HTMLElement>('.wk-up-crumb');
  if (crumb?.dataset.id) { goTo(crumb.dataset.id); docEl.scrollTop = 0; return; }
  // [[wikilink]] — inside this document it scrolls, anywhere else in the map it opens that page.
  // Same resolution as the canvas jump (utils/model.ts resolveWikilink), so a link goes to the
  // same card in both views.
  const link = t.closest<HTMLElement>('a.wikilink');
  if (link) {
    e.preventDefault();
    const name = link.dataset.target ?? '';
    const hit = resolveWikilink(name)[0];
    if (hit) goTo(hit.id);
    else createFromLink(name, link.closest<HTMLElement>('.wk-sec')?.dataset.id);
    return;
  }
  // a sub-page card — open it as the page
  const sub = t.closest<HTMLElement>('.wk-sub');
  if (sub?.dataset.id) { goTo(sub.dataset.id); return; }
  // "Make a page" — split this section off (see promoteToPage)
  const mk = t.closest<HTMLElement>('.wk-mkpage');
  const mkId = mk?.closest<HTMLElement>('.wk-sec')?.dataset.id;
  if (mkId) { promoteToPage(mkId); return; }
  // ↗ — hand this card back to the canvas, selected: the way out of reading and into rearranging
  const jump = t.closest<HTMLElement>('.wk-jump');
  const id = jump?.closest<HTMLElement>('.wk-sec')?.dataset.id;
  if (id && state.nodes.has(id)) { selectNode(id); setWiki(false); }
});

// ---- splitting a document ----
// "Make a page" turns the section's CARD into a FRAME, which is what a sub-page is here — so the
// split is the same act on the board (a box you can open) as it is in the document, and it is undone
// by the same type chip. Offered from the reading view because that is where you notice a page has
// grown too long. setTypeOn is float-bar's own conversion, reused rather than re-spelled: the box
// seed, the layout fallback and the order reseed all have to happen together.
function promoteToPage(id: string): void {
  const n = state.nodes.get(id);
  if (!n || n.type !== 'card') return;
  if (state.readOnly) { setStatus('Read-only — nothing is saved'); return; }
  if (isLockedEffective(n)) { setStatus('Locked — unlock it on the canvas first'); return; }
  if (!setTypeOn([id], 'frame')) return;
  setStatus(`“${nodeLabel(n)}” is a page now`);
  renderWiki();
}

// ---- editing a section in place ----
// One textarea over the section, holding the note the way the FILE holds it: the `# ` heading line
// and the body together (joinHeading), split back apart on commit (splitHeading). Same contract as
// the in-card editor (features/inline-edit.ts) and the outline's panel editor, and it borrows the
// latter's `ui.panelEdit` slot — the two can't be open at once (the views are exclusive), and being
// in that slot is what freezes the file rename while you type and keeps an external-change reload
// from yanking the text away (core/ui-state.ts editSessionActive / frozenFileNodeId).
let editId: string | null = null;

export function wikiEditing(): boolean { return !!editId; }

function startWikiEdit(n: MindNode): void {
  if (editId === n.id) return;
  if (editId) commitWikiEdit();
  if (state.readOnly) { setStatus('Read-only — nothing is saved'); return; }
  if (isLockedEffective(n)) { setStatus('Locked — unlock it on the canvas to edit'); return; }
  const sec = sectionEl(n.id);
  if (!sec) return;
  editId = n.id;
  touch(n.id);   // the whole session is ONE undo step
  ui.panelEdit = { id: n.id, origTitle: n.title, origBody: n.body };

  const ta = document.createElement('textarea');
  ta.className = 'wk-edit';
  ta.value = joinHeading(n.title, n.body, n.titleGap !== false);
  ta.spellcheck = false;
  const size = (): void => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; };
  ta.addEventListener('input', size);
  ta.addEventListener('paste', (e) => { pasteUrlLink(e, ta); });   // a URL over a selection → a link
  ta.addEventListener('blur', () => commitWikiEdit());
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();   // keep the global card/canvas shortcuts out while typing
    if (e.key === 'Escape') { e.preventDefault(); commitWikiEdit({ cancel: true }); }
    else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); commitWikiEdit(); }
  });
  sec.textContent = '';   // a section holds only its OWN heading + body; its children are siblings
  sec.append(ta);
  size();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

// Commit (or discard) the open session and repaint. `editId` is cleared FIRST so the rebuild's own
// blur — removing the textarea fires one — lands back here as a no-op instead of recursing.
function commitWikiEdit({ cancel = false }: { cancel?: boolean } = {}): void {
  const id = editId;
  if (!id) return;
  editId = null;
  ui.panelEdit = null;             // null first → the deferred file rename lands on the next save
  const ta = docEl.querySelector<HTMLTextAreaElement>('.wk-edit');
  const n = state.nodes.get(id);
  let changed = false;
  if (n && !cancel && ta) {
    changed = ta.value !== joinHeading(n.title, n.body, n.titleGap !== false);
    if (changed) {
      const { title, body, gap } = splitHeading(ta.value);
      n.title = title; n.body = body; n.titleGap = gap;
      n.dirty = true;
    }
  }
  renderWiki();          // put the rendered section back before anything measures
  if (changed) { remeasure(); scheduleSave(); }   // the card's own height changed on the canvas too
  commitStep();          // cancelled / unchanged sessions are discarded
}

// Double-click anywhere in a section edits it — the canvas gesture, in a document. Ignored on a
// link (a single click already followed it) and while a session is open (double-clicking inside
// the textarea is just selecting a word).
docEl.addEventListener('dblclick', (e) => {
  const t = e.target as HTMLElement;
  if (editId || t.closest('a') || t.closest('.wk-edit') || t.closest('.wk-jump')) return;
  const id = t.closest<HTMLElement>('.wk-sec')?.dataset.id;
  const n = id ? state.nodes.get(id) : null;
  if (!n) return;
  e.preventDefault();
  startWikiEdit(n);
});

// ---- a [[wikilink]] to a card that doesn't exist yet ----
// Writing the link is what creates the note: it lands as a CHILD of the section the link was
// written in — so the outline grows the way the prose does, and the new page is already part of the
// document you're reading — and opens for editing straight away. A link inside a LEAF (an
// annotation, an image card) can't take a child, so it re-anchors to that leaf's own parent.
function createFromLink(name: string, hostId: string | undefined): void {
  if (state.readOnly) { setStatus(`No card titled “${name}” — read-only, so none was created`); return; }
  let host = hostId ? state.nodes.get(hostId) ?? null : null;
  if (host && isLeafType(host)) host = host.parent ? state.nodes.get(host.parent) ?? null : null;
  const sibs = host ? childrenOf(host.id).length : 0;
  const n = createNode({
    parent: host?.id ?? null,
    title: name,
    // beside its parent, the way addChild places one — the canvas is covered, so there is no
    // pointer to drop it at and no visible spot for the user to have chosen
    x: host ? host.x + 40 + sibs * 30 : undefined,
    y: host ? host.y + 150 + sibs * 10 : undefined,
    edit: false,   // the wiki has its own editor; the canvas one would open behind this view
  });
  if (!n) return;   // refused (locked parent) — createNode has already said why
  setStatus(`Created “${name}”`);
  renderWiki();
  goTo(n.id);
  const fresh = state.nodes.get(n.id);
  if (fresh) startWikiEdit(fresh);
}
