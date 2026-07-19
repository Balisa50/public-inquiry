import {
  ID_LEN,
  KEY_LEN,
  MAX_OPTIONS,
  makeId,
  sha,
  clean,
  cleanMultiline,
  isValidId,
  isValidUploadId,
  putJson,
  readJson,
  readState,
  applyState,
  casePath,
  uploadPath,
  blobUrl,
  readBody,
  fail,
} from './_lib.js';
import { detectEmbed } from './preview.js';

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

  let kase, state;
  try {
    [kase, state] = await Promise.all([readJson(casePath(id)), readState(id)]);
  } catch (err) {
    return fail(res, 502, 'The registry is not answering. Try again in a moment.', {
      detail: String(err?.message || err),
    });
  }
  if (!kase) return fail(res, 404, 'No case filed under that number.');

  const view = applyState(kase, state);

  if (view.closed) {
    // Do not cache a takedown, so lifting one takes effect immediately.
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ok: true,
      id: view.id,
      serial: view.serial,
      closed: true,
      question: view.question,
    });
  }

  /**
   * Short edge cache only. A host takedown or a report threshold has to reach
   * readers quickly, and anything longer means moderated content keeps being
   * served from cache after it was pulled. Ten seconds still absorbs the
   * stampede when a link lands in a busy group chat.
   */
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=10');
  return res.status(200).json({
    ok: true,
    id: view.id,
    serial: view.serial,
    kind: view.kind,
    evidence: view.evidence,
    question: view.question,
    options: view.options,
    link: view.link || null,
    image: view.image || null,
    createdAt: view.createdAt,
  });
}

async function createCase(req, res, debug) {
  const body = readBody(req);

  const evidence = cleanMultiline(body.evidence, 1200);
  const question = clean(body.question, 140);
  const rawOptions = Array.isArray(body.options) ? body.options : [];
  const options = rawOptions.map((o) => clean(o, 60)).filter(Boolean).slice(0, MAX_OPTIONS);

  // A link or a photo can carry the case on its own, so the written evidence
  // only has to stand alone when there is nothing attached to it.
  const hasAttachment = Boolean(body.link?.url) || isValidUploadId(body.imageId);
  const minEvidence = hasAttachment ? 0 : 10;

  if (evidence.length < minEvidence) return fail(res, 400, 'The evidence needs a bit more than that.');
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

  // The client sends back what /api/preview returned, so re-derive anything
  // that matters rather than trusting the round trip. The embed in particular
  // decides what gets put in an iframe.
  let link = null;
  if (body.link?.url) {
    try {
      const u = new URL(String(body.link.url));
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        let image = clean(body.link.image, 600);
        if (image && !/^https:\/\//i.test(image)) image = '';
        link = {
          url: u.href,
          title: clean(body.link.title, 200),
          site: clean(body.link.site, 80) || u.hostname.replace(/^www\./, ''),
          image,
          embed: detectEmbed(u),
        };
      }
    } catch {
      link = null;
    }
  }

  // An upload id is only worth anything if the blob actually landed, so resolve
  // it here instead of taking a URL from the browser.
  let image = null;
  if (isValidUploadId(body.imageId)) {
    try {
      const url = await blobUrl(uploadPath(body.imageId));
      if (url) image = { url, id: body.imageId };
    } catch {
      image = null;
    }
  }

  if (!hasAttachment && evidence.length < 10) {
    return fail(res, 400, 'The evidence needs a bit more than that.');
  }

  const kase = {
    id,
    serial,
    kind: image ? 'image' : link ? 'link' : 'text',
    evidence,
    question,
    options,
    ...(link ? { link } : {}),
    ...(image ? { image } : {}),
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
