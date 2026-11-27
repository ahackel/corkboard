import { createHash } from 'node:crypto';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import pkg from './package.json' with { type: 'json' };

// Only the one inline script (by hash) may run, so markup slipping through utils/markdown.ts stays inert.
// Must run after viteSingleFile, which inlines the script; build only, as the dev server injects its own.
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

// APP_VERSION is set by the deploy workflow only.
const appVersion = process.env.APP_VERSION || `${pkg.version}-dev`;

// version.json is polled by a window left open to spot a newer deploy (src/features/update.ts).
function versionFile() {
  return {
    name: 'corkboard-version',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version: appVersion }) + '\n' });
    },
  };
}

export default defineConfig({
  // GitHub Pages serves the app under a subpath.
  base: './',
  publicDir: 'public',
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  plugins: [viteSingleFile(), contentSecurityPolicy(), versionFile()],
  // happy-dom: core/state.ts looks up the DOM shell on import.
  test: { environment: 'happy-dom', include: ['tests/**/*.test.ts'] },
  build: {
    target: 'es2020',
    assetsInlineLimit: Infinity,
  },
});
