import { del } from '@vercel/blob';
import {
  ID_LEN,
  KEY_LEN,
  sha,
  clean,
  isValidId,
  putJson,
  readJson,
  casePath,
  listAll,
  readBody,
  fail,
} from './_lib.js';

/**
 * Host moderation. The host key lives only in the host's own copy of the link
 * and only its hash is stored, so possession of the link is the whole auth
 * model. Deleting writes a tombstone rather than editing anything shared.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return fail(res, 405, 'Method not allowed.');
  }

  const body = readBody(req);
  const id = clean(body.id, ID_LEN).toLowerCase();
  const hostKey = clean(body.key, KEY_LEN);
  const target = clean(body.target, 10);
  const action = clean(body.action, 10) || 'delete';

  if (!isValidId(id)) return fail(res, 400, 'That case number is not valid.');
  if (!target) return fail(res, 400, 'Nothing selected.');

  let kase;
  try {
    kase = await readJson(casePath(id));
  } catch (err) {
    return fail(res, 502, 'The registry is not answering.', {
      detail: String(err?.message || err),
    });
  }
  if (!kase) return fail(res, 404, 'No case filed under that number.');
  if (!hostKey || sha(hostKey) !== kase.hostKeyHash) {
    return fail(res, 403, 'That key does not open this case.');
  }

  const path = `c/${id}/x/${target}.json`;
  try {
    if (action === 'restore') {
      const existing = await listAll(path);
      await Promise.all(existing.map((b) => del(b.url)));
    } else {
      await putJson(path, { at: Date.now() });
    }
  } catch (err) {
    return fail(res, 502, 'That did not go through. Try again.', {
      detail: String(err?.message || err),
    });
  }

  return res.status(200).json({ ok: true, target, action });
}
