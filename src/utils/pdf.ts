// A one-page PDF holding one JPEG that fills the page: all a picture export needs, so no library.
// PDF readers draw a JPEG natively (DCTDecode), so the bytes go in exactly as the canvas encoded them.

const MAX_PT = 14400;   // 200in, the largest page Acrobat opens

export function jpegPdf(jpeg: Uint8Array, imgW: number, imgH: number, pageW: number, pageH: number): Uint8Array {
  const fit = Math.min(1, MAX_PT / Math.max(pageW, pageH));
  const w = +(pageW * fit).toFixed(2), h = +(pageH * fit).toFixed(2);
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [], offsets: number[] = [];
  let len = 0;
  const put = (x: string | Uint8Array): void => {
    const b = typeof x === 'string' ? enc.encode(x) : x;
    parts.push(b);
    len += b.length;
  };
  const open = (): void => {
    offsets.push(len);
    put(`${offsets.length} 0 obj\n`);
  };
  const draw = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
  put('%PDF-1.4\n');
  open(); put('<</Type/Catalog/Pages 2 0 R>>\nendobj\n');
  open(); put('<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n');
  open(); put(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${w} ${h}]/Resources<</XObject<</Im0 4 0 R>>>>/Contents 5 0 R>>\nendobj\n`);
  open(); put(`<</Type/XObject/Subtype/Image/Width ${imgW}/Height ${imgH}/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode/Length ${jpeg.length}>>\nstream\n`);
  put(jpeg); put('\nendstream\nendobj\n');
  open(); put(`<</Length ${draw.length}>>\nstream\n${draw}\nendstream\nendobj\n`);
  const xref = len;
  put(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join(''));
  put(`trailer\n<</Size ${offsets.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(len);
  let at = 0;
  for (const b of parts) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}
