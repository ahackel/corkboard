// Modules under data/ wire up the page as they load, so a test that imports them needs its shell first.
// Booting the app opens IndexedDB, which the test DOM lacks, and no data test needs it.
import { vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../src/boot.js', () => ({ boot: async () => {}, showStart() {}, hideStart() {} }));
document.body.innerHTML = readFileSync('index.html', 'utf8').replace(/^[\s\S]*<body[^>]*>|<\/body>[\s\S]*$/g, '')
  .replace(/<script[\s\S]*?<\/script>/g, '');
