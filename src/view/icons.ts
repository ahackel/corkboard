// Every assets/icons/NAME.svg, mounted into each `<span class="ic" data-icon="NAME">` placeholder.
const modules = import.meta.glob('../assets/icons/*.svg', { query: '?raw', eager: true, import: 'default' });

const ICONS: Record<string, string> = {};
for (const [path, svg] of Object.entries(modules)) {
  const name = path.split('/').pop()!.replace(/\.svg$/, '');
  ICONS[name] = svg as string;
}

// For buttons whose face is rebuilt in JS and so can't take a placeholder.
export function chevron(): string { return `<span class="ic fb-chev">${ICONS.chevron ?? ''}</span>`; }

export function subChevron(): string { return `<span class="ic cm-chev">${ICONS.chevron ?? ''}</span>`; }

export function mountIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach(el => {
    const name = el.dataset.icon;
    if (name && ICONS[name]) {
      el.innerHTML = ICONS[name];
    }
  });
}

export const LOCK_BADGE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;

export const ICON_LOCK_OPEN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>`;

export const FOLDER_SVG = ICONS.folder ?? '';

export const DOCUMENT_SVG = ICONS.document ?? '';
