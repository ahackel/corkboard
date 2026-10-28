import { describe, expect, it } from 'vitest';
import { IMAGE_FILE_RE, IMAGE_URL_RE, IMAGE_ACCEPT, imageMimeFor, imageExtFor } from '../src/utils/image-types.js';

describe('image types', () => {
  it('knows a picture by its file name or link', () => {
    expect(IMAGE_FILE_RE.test('a/Photo.JPEG')).toBe(true);
    expect(IMAGE_FILE_RE.test('notes.md')).toBe(false);
    expect(IMAGE_URL_RE.test('https://x.y/cat.webp?w=200')).toBe(true);
    expect(IMAGE_ACCEPT).toBe('.png,.jpg,.jpeg,.gif,.webp,.svg,.avif,.bmp');
  });

  it('maps between extension and MIME type', () => {
    expect(imageMimeFor('attachments/x.SVG')).toBe('image/svg+xml');
    expect(imageMimeFor('x.txt')).toBeUndefined();
    expect(imageExtFor('image/jpeg')).toBe('.jpg');
    expect(imageExtFor('application/octet-stream')).toBe('.png');
  });
});
