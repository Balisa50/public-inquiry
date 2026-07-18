import {
  ID_LEN,
  VOTES_PER_FINGERPRINT,
  makeId,
  clean,
  cleanMultiline,
  isValidId,
  fingerprint,
  listAll,
  putJson,
  readJson,
  casePath,
  votePath,
  aggregate,
  readBody,
  fail,
} from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return fail(res, 405, 'Method not allowed.');
  }

  const debug = req.query?.debug === '1';
  const body = readBody(req);
  const id = clean(body.id, ID_LEN).toLowerCase();
  if (!isValidId(id)) return fail(res, 400, 'That case number is not valid.');

  let kase;
  try {
    kase = await readJson(casePath(id));
  } catch (err) {
    return fail(res, 502, 'The registry is not answering. Your answers are safe, try again.', {
      detail: String(err?.message || err),
    });
  }
  if (!kase) return fail(res, 404, 'No case filed under that number.');

  const choice = Number(body.choice);
  if (!Number.isInteger(choice) || choice < 0 || choice >= kase.options.length) {
    return fail(res, 400, 'Pick one of the options.');
  }

  let prediction = Math.round(Number(body.prediction));
  if (!Number.isFinite(prediction)) return fail(res, 400, 'Make a prediction first.');
  prediction = Math.min(100, Math.max(0, prediction));

  const comment = cleanMultiline(body.comment, 500);

  // Soft guard. Not airtight and not pretending to be. It stops a bored person
  // refreshing the page, it does not stop anyone determined.
  const fp = fingerprint(req, id);
  try {
    const priors = await listAll(`c/${id}/d/${fp}`);
    if (priors.length >= VOTES_PER_FINGERPRINT) {
      const results = await aggregate(id, kase);
      return res.status(200).json({
        ok: true,
        alreadyVoted: true,
        note: 'This device has already ruled on this case.',
        ...results,
      });
    }
    await putJson(`c/${id}/d/${fp}~${priors.length}.json`, { at: Date.now() });
  } catch {
    // A failing guard must never block a real vote.
  }

  const voteId = makeId(10);
  const ts = Date.now();
  const pathname = votePath(id, ts, voteId, choice, prediction, Boolean(comment));

  let written;
  try {
    written = await putJson(pathname, comment ? { t: comment } : {});
  } catch (err) {
    return fail(res, 502, 'Your ruling did not save. Nothing is lost, press submit again.', {
      detail: String(err?.message || err),
    });
  }

  let results;
  try {
    results = await aggregate(id, kase);
  } catch (err) {
    // The vote is recorded. Degrade to a bare result rather than losing it.
    return res.status(200).json({
      ok: true,
      voteId,
      degraded: true,
      note: 'Your ruling is recorded. The tally is slow right now, pull to refresh.',
      total: 0,
      counts: [],
      percents: [],
      comments: [],
      you: { choice, prediction },
      detail: String(err?.message || err),
    });
  }

  return res.status(200).json({
    ok: true,
    voteId,
    ...results,
    you: { choice, prediction },
    ...(debug ? { debug: { pathname: written.pathname, url: written.url, sdk: 'blob-v2' } } : {}),
  });
}
