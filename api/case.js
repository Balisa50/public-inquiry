import {
  ID_LEN,
  KEY_LEN,
  MAX_OPTIONS,
  makeId,
  sha,
  clean,
  cleanMultiline,
  isValidId,
  putJson,
  readJson,
  casePath,
  readBody,
  fail,
} from './_lib.js';

export default async function handler(req, res) {
  const debug = req.query?.debug === '1';

  if (req.method === 'GET') return getCase(req, res);
  if (req.method === 'POST') return createCase(req, res, debug);

  res.setHeader('Allow', 'GET, POST');
  return fail(res, 405, 'Method not allowed.');
}

/**
 * The commitment gate lives here. This endpoint returns the evidence and the
 * options and nothing else. No counts, no comments, no host key. There is
 * nothing in this response to read ahead in.
 */
async function getCase(req, res) {
  const id = clean(req.query?.id, ID_LEN).toLowerCase();
  if (!isValidId(id)) return fail(res, 400, 'That case number is not valid.');

  let kase;
  try {
    kase = await readJson(casePath(id));
  } catch (err) {
    return fail(res, 502, 'The registry is not answering. Try again in a moment.', {
      detail: String(err?.message || err),
    });
  }
  if (!kase) return fail(res, 404, 'No case filed under that number.');

  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
  return res.status(200).json({
    ok: true,
    id: kase.id,
    serial: kase.serial,
    kind: kase.kind,
    evidence: kase.evidence,
    question: kase.question,
    options: kase.options,
    createdAt: kase.createdAt,
  });
}

async function createCase(req, res, debug) {
  const body = readBody(req);

  const evidence = cleanMultiline(body.evidence, 1200);
  const question = clean(body.question, 140);
  const rawOptions = Array.isArray(body.options) ? body.options : [];
  const options = rawOptions.map((o) => clean(o, 60)).filter(Boolean).slice(0, MAX_OPTIONS);

  if (evidence.length < 10) return fail(res, 400, 'The evidence needs a bit more than that.');
  if (question.length < 3) return fail(res, 400, 'Every case needs a question.');
  if (options.length < 2) return fail(res, 400, 'Give the public at least two options.');
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) {
    return fail(res, 400, 'Two options are the same. Make them different.');
  }

  const id = makeId(ID_LEN);
  const hostKey = makeId(KEY_LEN);
  const now = Date.now();
  const d = new Date(now);
  const serial = `CASE-${d.getUTCFullYear()}-${String(id).slice(0, 4).toUpperCase()}`;

  const kase = {
    id,
    serial,
    kind: 'text',
    evidence,
    question,
    options,
    hostKeyHash: sha(hostKey),
    createdAt: now,
  };

  try {
    const blob = await putJson(casePath(id), kase);
    return res.status(200).json({
      ok: true,
      id,
      hostKey,
      serial,
      ...(debug ? { debug: { pathname: blob.pathname, url: blob.url, sdk: 'blob-v2' } } : {}),
    });
  } catch (err) {
    return fail(res, 502, 'The case could not be filed. Nothing was lost, try again.', {
      detail: String(err?.message || err),
    });
  }
}
