// ---------- UI icons ----------
// All icons live as .svg files under assets/icons and are loaded as raw strings (Vite
// inlines them in the single-file build). Markup in index.html carries a placeholder
// `<span class="ic" data-icon="NAME">`; mountIcons() fills each with its SVG. Adding an
// icon = drop a NAME.svg in assets/icons + a data-icon="NAME" placeholder.
const modules = import.meta.glob('../assets/icons/*.svg', { query: '?raw', eager: true, import: 'default' });

const ICONS: Record<string, string> = {};
for (const [path, svg] of Object.entries(modules)) {
  const name = path.split('/').pop()!.replace(/\.svg$/, '');
  ICONS[name] = svg as string;
}

// The dropdown chevron EVERY toolbar button that opens a menu or popover carries after its face (styles
// .fb-dd), for the buttons whose face is rebuilt in JS and so can't take a data-icon placeholder.
export function chevron(): string { return `<span class="ic fb-chev">${ICONS.chevron ?? ''}</span>`; }

export function mountIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach(el => {
    const name = el.dataset.icon;
    if (name && ICONS[name]) {
      el.innerHTML = ICONS[name];
    }
  });
}

// small closed-padlock badge shown at a locked card's upper-left corner; exported for the
// float bar's lock toggle (features/float-bar.ts), which shares this one glyph.
export const LOCK_BADGE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;

// …and the open one (unlocked), for the float bar's lock toggle.
export const ICON_LOCK_OPEN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>`;

// A closed folder: what a FOLDED section is drawn as, ahead of its label (styles.css .fold-icon).
export const FOLDER_SVG = ICONS.home ?? '';
