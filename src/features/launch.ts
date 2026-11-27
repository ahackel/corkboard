// What the INSTALLED app is launched with (public/manifest.webmanifest): a Markdown note the OS opened with
// Corkboard — "Open with", a double-click once it is the default — or one of the app icon's shortcuts.
//
// The manifest asks the OS to hand a launch to the window already open (launch_handler focus-existing), so
// everything arrives here, through `launchQueue`, never as a page load. A note opens in place exactly like
// one dropped on the pill (open-drop.ts): if asking for write access needs a click, the pill offers it.
// Without `launchQueue` (a tab, another browser) a shortcut's `?do=` is read from the page's own URL.
import { setStatus } from '../core/state.js';
import { booted, newDeviceMap, showStartOn } from '../boot.js';
import { open } from './open-drop.js';

interface LaunchParams { targetURL?: string; files: readonly FileSystemHandle[] }
interface LaunchQueue { setConsumer(consumer: (params: LaunchParams) => void): void }

const NOTE_RE = /\.(md|markdown)$/i;
const launchQueue = (window as Window & { launchQueue?: LaunchQueue }).launchQueue;

// A shortcut's action, from the URL it launched (manifest `shortcuts`): ?do=new | folders | notes.
async function runAction(url: string | undefined): Promise<void> {
  const action = url ? new URL(url).searchParams.get('do') : null;
  if (action === 'new') {
    await newDeviceMap();
  } else if (action === 'folders') {
    showStartOn('folder');
  } else if (action === 'notes') {
    showStartOn('note');
  }
}

// The `?do=` has done its job: a reload must not do it again.
function forgetAction(): void {
  const url = new URL(location.href);
  if (url.searchParams.has('do')) {
    url.searchParams.delete('do');
    history.replaceState(history.state, '', url);
  }
}

async function launched(params: LaunchParams): Promise<void> {
  await booted;
  forgetAction();
  const notes = params.files.filter(h => h.kind === 'file' && NOTE_RE.test(h.name));
  if (params.files.length) {
    await open(notes[0] ?? null);
    if (notes.length > 1) {
      setStatus(`Corkboard opens one note at a time — this is “${notes[0]!.name}”`);
    }
    return;
  }
  await runAction(params.targetURL);
}

export function installLaunch(): void {
  if (launchQueue) {
    launchQueue.setConsumer(params => { void launched(params); });
  } else if (new URLSearchParams(location.search).has('do')) {
    void launched({ targetURL: location.href, files: [] });
  }
}
