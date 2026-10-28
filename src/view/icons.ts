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
    if (name && ICONS[name]) el.innerHTML = ICONS[name];
  });
}
