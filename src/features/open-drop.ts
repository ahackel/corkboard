// Drag ONE Markdown note (or a folder) in from the OS and a pill at the top offers to OPEN it: the map becomes
// that very file, edited in place (boot.ts openDropped). A drop anywhere else still ADDS it to the board as a
// card where it lands (attachments.ts), so the drop point keeps deciding which section a copy goes in. A single
// note can't take a card beside it, so there a drop anywhere opens.
//
// Opening needs write access, and asking for it needs a click, which a drop from the OS may not count as:
// then the pill stays as a button naming the file, and its click finishes the job.
import { state, setStatus } from '../core/state.js';
import { store } from '../data/persistence.js';
import { byId } from '../utils/dom.js';
import { DOCUMENT_SVG, FOLDER_SVG } from '../view/icons.js';
import { openDropped } from '../boot.js';

type HandleItem = DataTransferItem & { getAsFileSystemHandle?(): Promise<FileSystemHandle | null> };

const CAN_OPEN = typeof DataTransferItem !== 'undefined' && 'getAsFileSystemHandle' in DataTransferItem.prototype;
// A note's type, or none — what a folder reports, and a note on an OS that maps no type to .md.
const OPENABLE_TYPES = ['text/markdown', 'text/x-markdown', ''];
const NOTE_RE = /\.(md|markdown)$/i;
const ASK_MS = 10000;

const pill = byId<HTMLButtonElement>('openDrop');
const title = byId('openDropTitle');
const sub = byId('openDropSub');
let asking: FileSystemHandle | null = null;
let askTimer = 0;

// Only one dragged item can be opened, and only an item that may be a note or a folder.
function openable(e: DragEvent): boolean {
  const items = e.dataTransfer?.items;
  return CAN_OPEN && !!items && items.length === 1 && items[0]!.kind === 'file' && OPENABLE_TYPES.includes(items[0]!.type);
}

function show(head: string, line: string, svg: string): void {
  title.textContent = head;
  sub.textContent = line;
  pill.firstElementChild!.innerHTML = svg;
  pill.hidden = false;
}

function hide(): void {
  pill.hidden = true;
  pill.classList.remove('hot', 'ask');
  asking = null;
  clearTimeout(askTimer);
}

function offerClick(handle: FileSystemHandle): void {
  asking = handle;
  pill.classList.add('ask');
  show(`Open “${handle.name}”`, 'Click to let Corkboard edit it', handle.kind === 'file' ? DOCUMENT_SVG : FOLDER_SVG);
  askTimer = window.setTimeout(hide, ASK_MS);
}

async function open(handle: FileSystemHandle | null): Promise<void> {
  if (!handle || (handle.kind === 'file' && !NOTE_RE.test(handle.name))) {
    setStatus('Only a Markdown note or a folder can be opened');
    return;
  }
  if (await openDropped(handle) === 'needs-click') {
    offerClick(handle);
  }
}

document.addEventListener('dragover', e => {
  if (!openable(e)) {
    return;
  }
  if (pill.hidden || asking) {
    hide();
    show(state.singleNote ? 'Drop to open it' : 'Drop here to edit it in place',
      state.singleNote ? `in place of “${store.name}”` : 'or on the board to add it as a card', DOCUMENT_SVG);
  }
  const over = state.singleNote || pill.contains(e.target as Node);
  pill.classList.toggle('hot', over);
  if (over) {
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
  }
}, true);

document.addEventListener('dragleave', e => {
  if (e.relatedTarget == null && !asking) {
    hide();
  }
}, true);

// Capture, so a drop meant to open never reaches the board's own drop handlers (attachments.ts).
document.addEventListener('drop', e => {
  if (pill.hidden || asking) {
    return;
  }
  const hot = pill.classList.contains('hot');
  hide();
  if (!hot || !openable(e)) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  // The handle must be asked for now: the dropped items are gone once this handler returns.
  const pending = (e.dataTransfer!.items[0] as HandleItem).getAsFileSystemHandle!();
  void pending.then(open, () => open(null));
}, true);

pill.addEventListener('click', () => {
  const handle = asking;
  hide();
  if (handle) {
    void open(handle);
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && asking) {
    hide();
  }
});
