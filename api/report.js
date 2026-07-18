import {
  ID_LEN,
  REPORT_THRESHOLD,
  sha,
  clean,
  isValidId,
  putJson,
  listAll,
  readState,
  statePath,
  caseReportPath,
  fingerprint,
  readBody,
  fail,
} from './_lib.js';

/**
 * Anyone who has ruled on a case can report a comment on it. Reports are keyed
 * by a hash of the reporter's vote id, so one person reporting five times is
 * still one report. At the threshold the comment stops being served at all.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return fail(res, 405, 'Method not allowed.');
  }

  const body = readBody(req);
  const id = clean(body.id, ID_LEN).toLowerCase();
  const voteId = clean(body.v, 10);
  const target = clean(body.target, 10);

  if (!isValidId(id)) return fail(res, 400, 'That case number is not valid.');
  if (!target) return fail(res, 400, 'Nothing selected.');

  /**
   * Reporting the case itself is deliberately open to anyone who can see it.
   * The evidence and any attached photo are visible before voting, so requiring
   * a vote first would mean the only way to report a photo of somebody is to
   * take part in judging them. Keyed by fingerprint so one person is one report.
   */
  if (target === 'case') {
    const fp = fingerprint(req, id);
    try {
      await putJson(caseReportPath(id, fp), { at: Date.now() });
      const reports = await listAll(`c/${id}/cr/`);
      if (reports.length >= REPORT_THRESHOLD) {
        const state = await readState(id);
        if (!state.closed) {
          state.closed = true;
          state.by = 'reports';
          state.at = Date.now();
          await putJson(statePath(id), state);
        }
      }
      return res.status(200).json({ ok: true, target, threshold: REPORT_THRESHOLD });
    } catch (err) {
      return fail(res, 502, 'The report did not go through. Try again.', {
        detail: String(err?.message || err),
      });
    }
  }

  if (!voteId) return fail(res, 403, 'Rule on the case first.');

  const voter = await listAll(`c/${id}/v/`).catch(() => []);
  const knows = voter.some((b) => b.pathname.includes(`~${voteId}~`));
  if (!knows) return fail(res, 403, 'Rule on the case first.');

  try {
    await putJson(`c/${id}/r/${target}~${sha(voteId).slice(0, 16)}.json`, { at: Date.now() });
  } catch (err) {
    return fail(res, 502, 'The report did not go through. Try again.', {
      detail: String(err?.message || err),
    });
  }

  return res.status(200).json({ ok: true, target, threshold: REPORT_THRESHOLD });
}
