import { createHash } from 'node:crypto';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import pkg from './package.json' with { type: 'json' };

// The built page may run its ONE inline script — named by its hash — and nothing else: no inline event
// handler, no script from anywhere. A note's text is turned into HTML by hand (utils/markdown.ts); if a
// mistake there ever let markup through, this is what keeps it from running. Styles stay inline (the
// single file), pictures may come from the map (blob:, data:) or the web, and nothing is framed or posted.
// After viteSingleFile, which is what puts the script inline. Build only: the dev server injects its own.
function contentSecurityPolicy() {
  return {
    name: 'corkboard-csp',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const page = bundle['index.html'];
      if (!page || page.type !== 'asset') {
        return;
      }
      const html = String(page.source);
      const hashes = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
        .map(m => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
      const policy = [
        "default-src 'none'",
        `script-src ${hashes.join(' ') || "'none'"}`,
        "style-src 'unsafe-inline'",
        "img-src 'self' data: blob: https: http:",
        "font-src 'self' data:",
        "connect-src 'self' data: blob: https:",
        "manifest-src 'self'",
        "worker-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; ');
      page.source = html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${policy}">`);
    },
  };
}

// The deploy workflow injects APP_VERSION (1.0.<deploys since 1.0.0>), so the version only
// bumps on actual deploys. Local/dev builds are marked as such instead of counting.
const appVersion = process.env.APP_VERSION || `${pkg.version}-dev`;

// The build emits ONE self-contained dist/index.html (JS + CSS inlined), so the
// deployed app stays a single file; public/sw.js keeps the last copy of it for when there is no network.
export default defineConfig({
  // GitHub Pages serves this project under a subpath. Relative base keeps asset URLs
  // resolving correctly under that subpath.
  base: './',
  publicDir: 'public',
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  plugins: [viteSingleFile(), contentSecurityPolicy()],
  // `npm test` (tests/): the modules under test import core/state.ts, which looks up the DOM shell.
  // e2e/ is Playwright's (`npm run e2e`), not vitest's.
  test: { environment: 'happy-dom', include: ['tests/**/*.test.ts'] },
  build: {
    target: 'es2020',
    // viteSingleFile inlines everything; no separate asset dir needed.
    assetsInlineLimit: Infinity,
  },
});
