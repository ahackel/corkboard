// The pill that OPENS a note or folder dragged in from the OS; a drop elsewhere adds a card instead.
// See "A note dragged in from the OS is OPENED on the pill" in docs/architecture.md.
import { state, setStatus } from '../core/state.js';
import { store } from '../data/active-store.js';
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

// Write access needs a click, which a drop from the OS may not count as.
function offerClick(handle: FileSystemHandle): void {
  asking = handle;
  pill.classList.add('ask');
  show(`Open “${handle.name}”`, 'Click to let Corkboard edit it', handle.kind === 'file' ? DOCUMENT_SVG : FOLDER_SVG);
  askTimer = window.setTimeout(hide, ASK_MS);
}

// Also how a note opened from the OS with the installed app arrives (features/launch.ts).
export async function open(handle: FileSystemHandle | null): Promise<void> {
  if (!handle || (handle.kind === 'file' && !NOTE_RE.test(handle.name))) {
    setStatus('Only a Markdown note or a folder can be opened');
    return;
  }
  let r: Awaited<ReturnType<typeof openDropped>>;
  try {
    r = await openDropped(handle);
  } catch (e) {
    console.error(e);
    setStatus(`“${handle.name}” couldn’t be opened. Try dropping it again.`);
    return;
  }
  if (r === 'needs-click') {
    offerClick(handle);
  }
}

export function installOpenDrop(): void {
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
}
