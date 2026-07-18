import { put } from '@vercel/blob';
import { makeId, readBody, fail, uploadPath } from './_lib.js';

/**
 * Takes one image for a case that has not been filed yet.
 *
 * The image arrives base64 encoded inside JSON rather than as a raw body. The
 * browser has already re-encoded it through a canvas, which caps the dimensions
 * and, more usefully, drops the EXIF block. Phone photos carry GPS coordinates
 * and a capture timestamp in EXIF, and this product promises anonymity to
 * everyone who reads a case. Shipping the original file would quietly break
 * that promise for anyone who attached a photo they took themselves.
 *
 * Uploads land under u/ and are only bound to a case when the case is filed.
 */

const MAX_BYTES = 3 * 1024 * 1024;

const SIGNATURES = [
  { ext: 'jpg', type: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    ext: 'png',
    type: 'image/png',
    test: (b) =>
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  {
    ext: 'webp',
    type: 'image/webp',
    test: (b) =>
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return fail(res, 405, 'Method not allowed.');
  }

  const body = readBody(req);
  const raw = typeof body.data === 'string' ? body.data : '';
  const b64 = raw.replace(/^data:image\/[a-z+]+;base64,/, '');
  if (!b64) return fail(res, 400, 'No image arrived.');
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) return fail(res, 400, 'That image did not survive the trip.');

  let buf;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    return fail(res, 400, 'That image did not survive the trip.');
  }

  if (!buf.length) return fail(res, 400, 'That image is empty.');
  if (buf.length > MAX_BYTES) return fail(res, 413, 'That image is too big. Keep it under 3MB.');

  // Trust the bytes, not the label. A content type header is whatever the
  // sender says it is.
  const sig = buf.length >= 12 ? SIGNATURES.find((s) => s.test(buf)) : null;
  if (!sig) return fail(res, 400, 'That file is not a JPEG, PNG or WebP.');

  const uploadId = `${makeId(14)}.${sig.ext}`;

  try {
    const blob = await put(uploadPath(uploadId), buf, {
      access: 'public',
      contentType: sig.type,
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: 31536000,
    });
    return res.status(200).json({ ok: true, uploadId, url: blob.url, bytes: buf.length });
  } catch (err) {
    return fail(res, 502, 'The image would not store. The case can still be filed without it.', {
      detail: String(err?.message || err),
    });
  }
}
