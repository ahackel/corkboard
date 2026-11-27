// Import first in a test whose modules read core/state.ts DOM handles. Boot is mocked: it needs IndexedDB.
import { vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../src/boot.js', () => ({ boot: async () => {}, showStart() {}, hideStart() {} }));
document.body.innerHTML = readFileSync('index.html', 'utf8').replace(/^[\s\S]*<body[^>]*>|<\/body>[\s\S]*$/g, '')
  .replace(/<script[\s\S]*?<\/script>/g, '');
