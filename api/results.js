import {
  ID_LEN,
  KEY_LEN,
  sha,
  clean,
  isValidId,
  readJson,
  casePath,
  aggregate,
  fail,
} from './_lib.js';

/**
 * Results are only ever served to someone who can produce a vote id that the
 * server can find on disk. A vote id is issued once, at the moment a vote is
 * written. There is no unauthenticated path to this data.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return fail(res, 405, 'Method not allowed.');
  }

  const id = clean(req.query?.id, ID_LEN).toLowerCase();
  const voteId = clean(req.query?.v, 10);
  const hostKey = clean(req.query?.k, KEY_LEN);

  if (!isValidId(id)) return fail(res, 400, 'That case number is not valid.');
  if (!voteId) return fail(res, 403, 'Rule on the case first.');

  let kase;
  try {
    kase = await readJson(casePath(id));
  } catch (err) {
    return fail(res, 502, 'The registry is not answering. Try again in a moment.', {
      detail: String(err?.message || err),
    });
  }
  if (!kase) return fail(res, 404, 'No case filed under that number.');

  const isHost = Boolean(hostKey) && sha(hostKey) === kase.hostKeyHash;

  let results;
  try {
    results = await aggregate(id, kase, { voteId, isHost });
  } catch (err) {
    return fail(res, 502, 'The tally is not answering. Try again in a moment.', {
      detail: String(err?.message || err),
    });
  }

  if (!results.you) return fail(res, 403, 'Rule on the case first.');

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    ok: true,
    isHost,
    serial: kase.serial,
    question: kase.question,
    options: kase.options,
    // Needed so a returning voter, who never loaded the case itself, can still
    // be shown the follow up they answered.
    q2: kase.q2 || null,
    ...results,
  });
}
