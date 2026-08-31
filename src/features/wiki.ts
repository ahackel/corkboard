// ---------- wiki view: a card and its subtree read as ONE document ----------
// The third view over the same nodes (body.wiki hides the canvas, the document renders into
// #wikiDoc and its contents list into #wikiToc), aimed at reading a long note — a design doc, a
// spec — the way a wiki reads, rather than as boxes on a plane. Toggled by the toolbar button /
// the W key; the choice persists per device in outline.ts's VIEW_KEY, which the two alternative
// views share so they can't disagree about which one is on.
//
// ONE question decides what a page is, and it is asked of the PARENT: does it hold PAGES or ITEMS?
//
//        a FRAME holds PAGES              ·              a CARD holds ITEMS
//
// A page is its own note plus its ITEMS — the lines of it — and it ENDS at the next frame, whose
// children are pages of their own. Child order is the canvas order (rootsInOrder / orderedKids), so
// dragging a card up its parent's stack moves the line up the page, and dragging a card up a frame
// moves the page up the tree. See holdsPages/pageOf below for why this is scaffolding.
//
// That is the third answer this view has given, and it is the two earlier ones' halves. The FIRST
// flattened a whole subtree into one document and gave every child a heading, which says every name
// twice — once in the contents tree, once as a heading with nothing under it — and made a frame the
// only way to say "sub-page", so a parent page had to be a box that can't hold prose. The SECOND
// made every node a page, which is right for a map of notes and absurd for a card holding a
// checklist: eleven contents rows for one day, each openable as a document of its own.
//
// Containment on the canvas means "is inside", and a wiki reads that two ways depending on what is
// doing the containing: a card with children is an OUTLINE (view/layout.ts isStack) and its rows are
// its lines, a frame is a SPACE you go inside (nav/scope.ts) and a space of notes is a branch of the
// tree. Neither inlines a child PAGE — no wiki does (Confluence's page tree, Notion's sub-pages,
// MediaWiki's `/`, BookStack's book/chapter/page) — and neither hides an ITEM behind a link.
//
// The view stays deliberately NARROW — four interactions and one naming convention, so most of the
// app still has nothing to say about it:
//   · DOUBLE-CLICK the page to edit its note, in place, as raw markdown. One textarea holding the whole
//     note — its `# ` heading line and its body together — because that is what the note IS on disk
//     (utils/frontmatter.ts joinHeading/splitHeading), exactly as the in-card editor holds it.
//   · A [[wikilink]] navigates within the document set — and one naming a card that DOESN'T EXIST
//     creates it, BESIDE the page the link was written in, then opens it for editing. That is how a
//     wiki grows, and it means writing a link is enough to grow the tree too. Such a link is drawn
//     as UNWRITTEN before you click it (markWikilinks) — MediaWiki's red link.
//   · The ↗ button in a heading hands that card back to the canvas, selected — read here, rearrange
//     there. It is a button rather than the heading itself so a stray click can't teleport you off
//     the page you're reading, now that clicking into text means editing it.
//   · The contents list and the crumb trail move between pages.
//   · A page named `Index` (or Home / README / Contents) renders the LISTING of its sub-pages, and
//     a root so named is where the view opens — the map's front page.
// Everything else — creating cards, deleting, colours, layout — stays on the canvas.
//
// Two things a card shows that a document shouldn't: a collapsed subtree is still reachable HERE
// (mm_collapsed is a canvas fold, and a page vanishing from the contents tree because it happens to
// be folded on the board would be a surprise), and annotations + query cards are skipped entirely —
// the first is canvas furniture pinned over its parent, the second a live search widget, and
// neither is prose.
import { state, setStatus, isAnnotation, isQueryCard, type MindNode } from '../core/state.js';
import { ui } from '../core/ui-state.js';
import { nodeLabel, childrenOf, parentOf, ancestors, isLockedEffective, rootsInOrder, resolveWikilink, wikilinkResolves, resetWikilinkIndex } from '../utils/model.js';
import { orderedKids } from '../view/layout.js';
import { renderBodyHTML } from '../utils/markdown.js';
import { joinHeading, splitHeading } from '../utils/frontmatter.js';
import { scopeRootNode } from '../nav/scope.js';
import { scheduleUrlSync, syncUrl, updateDocumentTitle } from '../nav/url-state.js';
import { scheduleSave } from '../data/persistence.js';
import { hydrateImages } from './images.js';
import { createNode } from './crud.js';
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
// Where the view opens: the frame you have open if you're inside one, else whatever is selected —
// through pageOf either way, since a selected checklist item is a LINE of a page rather than one —
// else the map's front page, else the first root.
function defaultPage(): string | null {
  const open = scopeRootNode();
  if (open) return pageOf(open).id;
  const sel = state.selId ? state.nodes.get(state.selId) : null;
  if (sel) return pageOf(sel).id;
  return (homeRoot() ?? rootsInOrder()[0])?.id ?? null;
}
// Navigation is ONE rule: a contents row, a crumb and a [[wikilink]] all open the PAGE of what they
// name (pageOf), so a link pointing at a card's item lands on the page that item is a line of rather
// than on nothing. Nothing scrolls to a section — a page's items are on it, not elsewhere.
function goTo(id: string): void {
  const target = state.nodes.get(id);
  if (!target) return;
  const page = pageOf(target);
  if (page.id === pageId) return;
  pageId = page.id;
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
  if (!target) return;
  const page = pageOf(target);   // a hash naming an item restores the page it is a line of
  if (page.id === pageId) return;
  pageId = page.id;
  renderWiki();
  docEl.scrollTop = 0;
  updateDocumentTitle();   // the tab names the page, and a restored one is still a page change
}

// ---- where a page ENDS ----
// At the next FRAME. Asked of the parent, as above: a frame holds pages, a card holds items — and a
// page's whole ancestry must hold pages, so the page tree is a PREFIX of the map's tree. The moment
// a card appears in the chain, everything below it is that card's own content, however deep.
//
// This is SCAFFOLDING, and it is written to be DELETED. It exists because containment currently
// does two jobs — "is a line of" and "is a page under" — and this is the first view that has to
// tell them apart. If the line-of job moves into the note's own text (a bullet list where child
// cards are now), every child is a page again and these three functions simply go away. Nothing
// here reaches disk: no `mm_*` key, no board.json entry, nothing to migrate back.
//
// Keyed on the RAW `type`, never view/layout.ts's isFrame: that one answers a RENDERING question (a
// collapsed frame is not a frame, a frame inside a stack is a row), and this view reads through
// both — a page dropping out of the contents tree because its box happens to be folded on the board
// would be exactly the surprise that keeping collapsed subtrees readable here already avoids.
function holdsPages(n: MindNode): boolean { return n.type === 'frame'; }
// The page a node is READ ON: itself when it is one, else the nearest ancestor that is. Every
// navigation goes through this, and it always answers — a root holds whatever it likes and is a page
// regardless, so the walk terminates. Annotations and query cards stop it too: canvas furniture and
// a live search widget are not prose, so a link landing on one reads its parent's page instead.
function pageOf(n: MindNode): MindNode {
  const chain = [n, ...ancestors(n)];            // near → far; the last is a root, always a page
  let page = chain[chain.length - 1];
  for (let i = chain.length - 2; i >= 0; i--) {
    const kid = chain[i];
    if (!holdsPages(chain[i + 1]) || isAnnotation(kid) || isQueryCard(kid)) break;
    page = kid;
  }
  return page;
}
//
// ---- an INDEX, by name ----
// A page shows its children as a LISTING only where it asks for one, because they are already rows
// in the contents tree beside it and printing them again says everything twice. The ask is the
// page's NAME — no new `mm_*` key, and no new gesture: you title a note `# Index`.
//
// Naming a FILE and naming a CARD are the same act here — the slug is re-derived from the leading
// `# ` line on every save — so a card titled “Index” IS `index.md`, and the convention every folder
// of Markdown already uses lands without a second spelling of it.
const INDEX_NAMES = new Set(['index', 'home', 'readme', 'contents', 'table of contents']);
export function isIndexNamed(n: MindNode): boolean { return INDEX_NAMES.has(n.title.trim().toLowerCase()); }
// The map's HOME: a root so named is where the view opens and where the contents tree starts. It is
// the one thing the map couldn't say before — with several roots, `first root` is an accident of
// where they sit on the board.
function homeRoot(): MindNode | null { return rootsInOrder().find(isIndexNamed) ?? null; }
// Roots for the contents tree, home first. Everything else keeps canvas order.
function pagesInOrder(): MindNode[] {
  const roots = rootsInOrder();
  const home = roots.find(isIndexNamed);
  return home ? [home, ...roots.filter(r => r !== home)] : roots;
}
// Does this index write its OWN list? A body carrying links IS the listing its author wanted, and
// generating a second one under it would be the duplication this whole rule exists to remove.
function listsItself(n: MindNode): boolean {
  return /\[\[[^\]]+\]\]|\[[^\]]*\]\([^)]+\)/.test(n.body);
}

// ---- the document ----
// A node's children in canvas order, less the two kinds that are never prose — an annotation (canvas
// furniture pinned over its parent) and a query card (a live search widget).
function kidsOf(n: MindNode): MindNode[] {
  return orderedKids(n, childrenOf(n.id)).filter(k => !isAnnotation(k) && !isQueryCard(k));
}
// …split by the one question above. Every child is one or the other and no child is both, which is
// what keeps the contents tree and the page's own text from ever saying the same name twice.
function childPages(n: MindNode): MindNode[] { return holdsPages(n) ? kidsOf(n) : []; }
function childItems(n: MindNode): MindNode[] { return holdsPages(n) ? [] : kidsOf(n); }
// A link to a page that doesn't exist yet is worth SEEING before you click it — every wiki says so,
// and they say it two ways. MediaWiki (and DokuWiki, and Confluence's `+` link) paints it RED, an
// error to be fixed, which suits an encyclopaedia where a red link is a gap in the record. The
// personal-wiki lineage — Obsidian, Logseq, TiddlyWiki, Dendron — mutes it instead, because there an
// unwritten link is a NOTE TO SELF, the normal way a map grows, and a page of red would read as a
// page of mistakes. This is a personal map, so: muted, dashed, and a tooltip that says what the
// click will do — which here is create the page, not fail.
function markWikilinks(root: ParentNode): void {
  for (const a of root.querySelectorAll<HTMLElement>('a.wikilink')) {
    const name = (a.dataset.target ?? '').trim();
    const missing = !wikilinkResolves(name);
    a.classList.toggle('missing', missing);
    a.title = missing ? `Create page “${name}”` : `Go to “${name}”`;
  }
}
// Everything a rendered note needs once its HTML has landed: pictures resolved, unwritten links
// marked, and every task box frozen — a reading surface writes nothing, so a `- [ ]` renders as it
// stands and can't be ticked here. One spelling, since a page's body and each of its items' bodies
// all want the same three.
function dressBody(el: HTMLElement): void {
  hydrateImages(el);
  markWikilinks(el);
  el.querySelectorAll<HTMLInputElement>('.taskbox').forEach(b => { b.disabled = true; });
}
// A NOTE in the DOM — the page's own `.wk-sec`, or one of its items' `.wk-item` rows. Both carry the
// id of the file behind them and both are edited in place by the same one textarea, because both ARE
// notes: an item is a card of the map that happens to read as a line here.
function sectionEl(id: string): HTMLElement | null {
  return docEl.querySelector<HTMLElement>(`.wk-sec[data-id="${CSS.escape(id)}"], .wk-item[data-id="${CSS.escape(id)}"]`);
}

// ---- the contents list ----
// The PAGE TREE — every page, at its own depth, home root first. That is what a wiki sidebar is
// (Confluence's page tree, BookStack's book tree). It needs no filtering of its own: childPages
// returns nothing for a card, so the walk stops at the first one and a day's eleven checklist items
// contribute the ONE row their page does. Nothing to expand or collapse into it either — where you
// are in the pages and where you are in the map are the same question.
interface TocRow { n: MindNode; depth: number }
function tocRows(): TocRow[] {
  const out: TocRow[] = [];
  const walk = (n: MindNode, depth: number): void => {
    out.push({ n, depth });
    for (const c of childPages(n)) walk(c, depth + 1);
  };
  for (const r of pagesInOrder()) walk(r, 0);
  return out;
}

// A child page, as it appears in a LISTING: a link card carrying the name, an excerpt and how much
// is under it — Docusaurus's DocCardList. Never the content: that is the whole point of the boundary.
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
  // how much is under it, counted in PAGES — descendantCount counts every node, which on a page
  // holding a checklist would report its lines as though they were documents of their own.
  const count = subPageCount(n);
  if (count) {
    const meta = document.createElement('span');
    meta.className = 'wk-sub-meta';
    meta.textContent = `${count} page${count === 1 ? '' : 's'}`;
    card.append(meta);
  }
  return card;
}
function subPageCount(n: MindNode): number {
  let c = 0; for (const k of childPages(n)) c += 1 + subPageCount(k); return c;
}

// The listing itself: the page's sub-pages, in canvas order. Rendered under an `Index` page, or as
// the whole body of a page that says nothing of its own.
function subPageList(page: MindNode): HTMLElement | null {
  const subs = childPages(page);
  if (!subs.length) return null;
  const list = document.createElement('div');
  list.className = 'wk-index';
  for (const n of subs) list.append(subPageCard(n));
  return list;
}

// ---- a page's ITEMS ----
// A card's children are LINES of its page, and they render as one nested list — the outline the
// canvas draws, set as prose. Never as headings: that was the first version of this view, and a
// parent listing its children's titles said every name twice. A list says it once, and it is what
// the thing already is on the board.
//
// Each row IS the note behind it: its title if it has one, its body under that, then its own items.
// Where the parent runs a checklist (`mm_checklist`) the rows wear its done marks — the same
// Trello-style box the canvas draws (main.ts showsDoneCheckbox) — disabled like every other control
// in here. Unlike the sub-page listing this is never suppressed: items are the page's own content,
// not a second spelling of the contents tree, so leaving them out would lose them altogether.
function itemRow(n: MindNode, checklist: boolean): HTMLElement {
  const li = document.createElement('li');
  li.className = 'wk-item';
  li.dataset.id = n.id;
  if (checklist) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'wk-item-box';
    box.checked = n.done;
    box.disabled = true;
    li.classList.add('checkitem');
    li.classList.toggle('done', n.done);
    li.append(box);
  }
  // A titled note names the row and puts its body under it. A title-less one IS its body, so it
  // renders as the paragraph it is — nodeLabel's `No-title 3` fallback is for LISTS OF NAMES, and
  // printing one in the middle of prose would be inventing text nobody wrote.
  const title = n.title.trim();
  if (title) {
    const name = document.createElement('span');
    name.className = 'wk-item-name';
    name.textContent = title;
    li.append(name);
  }
  if (n.body.trim()) {
    const body = document.createElement('div');
    body.className = 'wk-item-body';
    body.innerHTML = renderBodyHTML(n.body);
    dressBody(body);
    li.append(body);
  }
  const sub = itemList(n);
  if (sub) li.append(sub);
  return li;
}
function itemList(n: MindNode): HTMLElement | null {
  const items = childItems(n);
  if (!items.length) return null;
  const ul = document.createElement('ul');
  ul.className = 'wk-items';
  for (const k of items) ul.append(itemRow(k, n.checklist));
  return ul;
}

// ---- rendering ----
// Full rebuild, called from paintAll() so every mutation path keeps the document in sync for free
// (a no-op while another view is active). Scroll position survives a rebuild of the same page —
// autosave's paintAll must not throw you back to the top mid-read.
export function renderWiki(): void {
  if (!wikiActive()) return;
  if (editId) return;   // a rebuild would blow away the open textarea (autosave's paintAll lands here)
  resetWikilinkIndex();   // a page renamed or created since the last render must re-resolve
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
  for (const { n, depth } of tocRows()) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'wk-row';
    row.dataset.id = n.id;
    row.style.paddingLeft = `${10 + depth * 12}px`;
    row.textContent = nodeLabel(n);
    row.title = nodeLabel(n);
    row.classList.toggle('page', n.id === pageId);
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
  // the page's own note — the ONE section a page has
  const sec = document.createElement('section');
  sec.className = 'wk-sec';
  sec.dataset.id = page.id;
  if (page.title.trim()) {
    const h = document.createElement('h1');
    h.className = 'wk-h';
    h.textContent = page.title.trim();
    const jump = document.createElement('button');
    jump.type = 'button'; jump.className = 'wk-jump';
    jump.textContent = '↗';
    jump.title = 'Show this card on the canvas';
    jump.setAttribute('aria-label', `Show “${page.title.trim()}” on the canvas`);
    h.append(jump);
    sec.append(h);
  }
  const body = document.createElement('div');
  body.className = 'wk-body';
  body.innerHTML = renderBodyHTML(page.body);
  dressBody(body);
  sec.append(body);
  // …then its ITEMS, inside the section: they are this page's own content, so the in-place editor
  // clearing `.wk-sec` takes them with it and the rebuild on commit puts them back.
  const items = itemList(page);
  if (items) sec.append(items);
  wrap.append(sec);

  // …and the LISTING, where the page asked for one by its name, or where it said nothing at all and
  // would otherwise read as a bare title. An index that already wrote its own list of links keeps it
  // (listsItself) — generating a second one under it is the duplication this rule exists to remove.
  if (isIndexNamed(page) ? !listsItself(page) : !page.body.trim()) {
    const list = subPageList(page);
    if (list) wrap.append(list);
  }
  docEl.append(wrap);
  shownPageId = pageId;
  docEl.scrollTop = keepScroll;
}

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
  // a listing card — open it as the page
  const sub = t.closest<HTMLElement>('.wk-sub');
  if (sub?.dataset.id) { goTo(sub.dataset.id); return; }
  // ↗ — hand this card back to the canvas, selected: the way out of reading and into rearranging
  const jump = t.closest<HTMLElement>('.wk-jump');
  const id = jump?.closest<HTMLElement>('.wk-sec')?.dataset.id;
  if (id && state.nodes.has(id)) { selectNode(id); setWiki(false); }
});

// ---- editing a page in place ----
// One textarea over the page's note, holding it the way the FILE holds it: the `# ` heading line
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
  sec.textContent = '';   // one field holds this note alone — its items are notes of their own
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

// Double-click anywhere in the page edits its note — the canvas gesture, in a document. Ignored on a
// link (a single click already followed it) and while a session is open (double-clicking inside
// the textarea is just selecting a word).
docEl.addEventListener('dblclick', (e) => {
  const t = e.target as HTMLElement;
  if (editId || t.closest('a') || t.closest('.wk-edit') || t.closest('.wk-jump')) return;
  // the nearest NOTE, which on a page's item is that item's own file rather than the page's
  const id = t.closest<HTMLElement>('.wk-item, .wk-sec')?.dataset.id;
  const n = id ? state.nodes.get(id) : null;
  if (!n) return;
  e.preventDefault();
  startWikiEdit(n);
});

// ---- a [[wikilink]] to a card that doesn't exist yet ----
// Writing the link is what creates the note, and it lands as a SIBLING of the page it was written
// in — so the new note is a PAGE, which a child would not be wherever that page is a card (a card
// holds items). Inside a frame that reads as "next to the page you're on, in the same space"; at the
// top level it is a new root. Either way it opens for editing straight away, which is how a wiki
// grows: writing the link is enough to grow the tree too.
function createFromLink(name: string, hostId: string | undefined): void {
  if (state.readOnly) { setStatus(`No card titled “${name}” — read-only, so none was created`); return; }
  const from = hostId ? state.nodes.get(hostId) ?? null : null;
  const page = from ? pageOf(from) : null;
  const host = page ? parentOf(page) : null;
  const sibs = host ? childrenOf(host.id).length : 0;
  const n = createNode({
    parent: host?.id ?? null,
    title: name,
    // beside the page it was linked from, the way addChild places one — the canvas is covered, so
    // there is no pointer to drop it at and no visible spot for the user to have chosen
    x: page ? page.x + 40 + sibs * 30 : undefined,
    y: page ? page.y + 150 + sibs * 10 : undefined,
    edit: false,   // the wiki has its own editor; the canvas one would open behind this view
  });
  if (!n) return;   // refused (locked parent) — createNode has already said why
  setStatus(`Created “${name}”`);
  renderWiki();
  goTo(n.id);
  const fresh = state.nodes.get(n.id);
  if (fresh) startWikiEdit(fresh);
}
