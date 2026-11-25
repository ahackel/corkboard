// Is this the DESKTOP app's build (`npm run build:desktop`, src-tauri/)? The app ships the page inside itself
// and updates as a whole, so what only a web page needs is left out of it: the offline copy (public/sw.js)
// and the Update button (features/update.ts). Its own CSP comes from src-tauri/tauri.conf.json.
export const DESKTOP_BUILD = import.meta.env.MODE === 'desktop';
