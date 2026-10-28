import { describe, expect, it } from 'vitest';
import { zipBytes, unzip } from '../src/utils/zip.js';

describe('zip', () => {
  const files = [{ name: 'Ideen/Übersicht 🔥.md', data: '# Hi' }, { name: 'a.png', bytes: new Uint8Array([1, 2, 3]) }];

  it('marks every entry name as UTF-8, in the local and the central header', () => {
    const bytes = zipBytes(files);
    const dv = new DataView(bytes.buffer);
    const flagsAt = (sig: number, offset: number): number[] => {
      const out: number[] = [];
      for (let i = 0; i + 4 <= bytes.length; i++) {
        if (dv.getUint32(i, true) === sig) {
          out.push(dv.getUint16(i + offset, true));
        }
      }
      return out;
    };
    expect(flagsAt(0x04034b50, 6)).toEqual([0x0800, 0x0800]);
    expect(flagsAt(0x02014b50, 8)).toEqual([0x0800, 0x0800]);
  });

  it('reads back what it wrote', async () => {
    const back = await unzip(zipBytes(files).buffer as ArrayBuffer);
    expect(back.map(e => e.name)).toEqual(files.map(f => f.name));
    expect(back[0].text).toBe('# Hi');
    expect([...back[1].bytes]).toEqual([1, 2, 3]);
  });
});
