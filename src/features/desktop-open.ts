// What Finder opens WITH the desktop app — a double-click on a note once Corkboard is its app, Open With,
// a note or folder dropped on the Dock icon — opens in place (boot.ts openLocalPath). The native side keeps
// the paths until the page takes them (src-tauri/src/main.rs), so one handed over while the app was still
// starting waits for boot instead of being lost. Only in the desktop build.
import { setStatus } from '../core/state.js';
import { booted, openLocalPath } from '../boot.js';
import { native, baseName } from '../store/desktop-bridge.js';
import { DESKTOP_BUILD } from '../utils/desktop.js';

async function takeOpened(): Promise<void> {
  const paths = await native.takeOpened();
  if (!paths.length) {
    return;
  }
  await openLocalPath(paths[0]!);
  if (paths.length > 1) {
    setStatus(`Corkboard opens one at a time — this is “${baseName(paths[0]!)}”`);
  }
}

if (DESKTOP_BUILD) {
  void booted.then(async () => {
    await native.onOpened(() => { void takeOpened(); });
    await takeOpened();
  });
}
