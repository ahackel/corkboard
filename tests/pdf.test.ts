// The picture export's PDF: every cross-reference must point at the object it names, or readers
// reject (or silently "repair") the file.
import { describe, expect, it } from 'vitest';
import { jpegPdf } from '../src/utils/pdf.js';

const text = (b: Uint8Array): string => new TextDecoder('latin1').decode(b);

describe('jpegPdf', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0x0a, 0x25, 0xff, 0xd9]);   // a newline and a % inside the stream must not matter

  it('points every xref entry and startxref at what they name', () => {
    const pdf = text(jpegPdf(jpeg, 20, 10, 15, 7.5));
    const xref = Number(/startxref\n(\d+)/.exec(pdf)![1]);
    expect(pdf.slice(xref, xref + 4)).toBe('xref');
    const entries = [...pdf.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map(m => Number(m[1]));
    expect(entries).toHaveLength(5);
    entries.forEach((o, i) => expect(pdf.slice(o).startsWith(`${i + 1} 0 obj`)).toBe(true));
    expect(pdf).toContain(`/Length ${jpeg.length}>>`);
    expect(pdf).toContain('/MediaBox[0 0 15 7.5]');
  });

  it('shrinks a page past the largest a reader opens, keeping its shape', () => {
    expect(text(jpegPdf(jpeg, 1, 1, 28800, 7200))).toContain('/MediaBox[0 0 14400 3600]');
  });
});
