// ---------- UI icons ----------
// All icons live as .svg files under assets/icons and are loaded as raw strings (Vite
// inlines them in the single-file build). Markup in index.html carries a placeholder
// `<span class="ic" data-icon="NAME">`; mountIcons() fills each with its SVG. Adding an
// icon = drop a NAME.svg in assets/icons + a data-icon="NAME" placeholder. (The theme
// toggle swaps its own moon/sun icon dynamically — see theme.ts — so it has no placeholder.)
const modules = import.meta.glob('../assets/icons/*.svg', { query: '?raw', eager: true, import: 'default' });

const ICONS: Record<string, string> = {};
for (const [path, svg] of Object.entries(modules)) {
  const name = path.split('/').pop()!.replace(/\.svg$/, '');
  ICONS[name] = svg as string;
}

// The folder outline the FRAME kind wears. A frame renders as a box with a folder TAB above its
// top-left corner, so every icon that stands for one is a folder: the kind chip and all three of its
// layout chips (features/float-bar.ts) and the glyph on a folded tab group's pill (FOLDER_SVG in
// main.ts). Kept here — a module neither of those two can cycle with — as the ONE spelling of the
// shape, and as a bare path so each caller can drop its own content blocks inside it. Its interior
// (below the tab, inside the stroke) is roughly x 5.5…19, y 9.5…18. It fills 3.5…20.5 × 4…20 — the
// full width the image/query icons take, so a folder doesn't read as the small one of the set.
export const FOLDER_PATH = '<path d="M3.5 5.5A1.5 1.5 0 0 1 5 4h3.4l2 2.5h8.6A1.5 1.5 0 0 1 20.5 8v10A1.5 1.5 0 0 1 19 20H5a1.5 1.5 0 0 1-1.5-1.5Z"/>';

export function mountIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach(el => {
    const name = el.dataset.icon;
    if (name && ICONS[name]) el.innerHTML = ICONS[name];
  });
}
