// What the INSTALLED app is launched with: a note the OS opened with it, or an icon shortcut's `?do=`.
// See "The INSTALLED app opens notes from the OS" in docs/architecture.md.
import { setStatus } from '../core/state.js';
import { booted, newDeviceMap, showStartOn } from '../boot.js';
import { open } from './open-drop.js';

interface LaunchParams { targetURL?: string; files: readonly FileSystemHandle[] }
interface LaunchQueue { setConsumer(consumer: (params: LaunchParams) => void): void }

const NOTE_RE = /\.(md|markdown)$/i;
const launchQueue = (window as Window & { launchQueue?: LaunchQueue }).launchQueue;

// manifest `shortcuts`: ?do=new | folders | notes.
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

// A reload must not run the action again.
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
