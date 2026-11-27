// Modules under data/ read the page shell (core/state.ts DOM handles), so a test that imports them needs it first.
// Booting the app opens IndexedDB, which the test DOM lacks, and no data test needs it.
import { vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../src/boot.js', () => ({ boot: async () => {}, showStart() {}, hideStart() {} }));
document.body.innerHTML = readFileSync('index.html', 'utf8').replace(/^[\s\S]*<body[^>]*>|<\/body>[\s\S]*$/g, '')
  .replace(/<script[\s\S]*?<\/script>/g, '');
