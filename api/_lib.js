import { put, list } from '@vercel/blob';
import { createHash, randomBytes } from 'node:crypto';

// No 0, 1, i, l, o, k. Ambiguous characters cause typos when links get read out
// loud, and 'k' is the separator between a case id and a host key in the URL.
const ALPHABET = '23456789abcdefghjmnpqrstuvwxyz';

export const ID_LEN = 8;
export const KEY_LEN = 20;
export const MAX_OPTIONS = 4;
export const REPORT_THRESHOLD = 3;
export const VOTES_PER_FINGERPRINT = 3;

const SALT = process.env.PI_SALT || 'inquiry-default-salt-change-me';

export function makeId(n) {
  const bytes = randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function sha(s) {
  return createHash('sha256').update(String(s)).digest('hex');
}

// Whitespace tolerant on every field a human types into.
export function clean(v, max) {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function cleanMultiline(v, max) {
  return String(v ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

export function isValidId(id) {
  return typeof id === 'string' && new RegExp(`^[${ALPHABET}]{${ID_LEN}}$`).test(id);
}

/**
 * A soft, per case vote guard. This is a salted hash of coarse request data.
 * It lives under its own prefix and is never written next to a vote or a
 * comment, so it cannot be joined back to anything a person said.
 */
export function fingerprint(req, caseId) {
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';
  const ua = req.headers['user-agent'] || 'unknown';
  return sha(`${SALT}|${caseId}|${ip}|${ua}`).slice(0, 32);
}

export async function listAll(prefix) {
  const out = [];
  let cursor;
  do {
    const r = await list({ prefix, cursor, limit: 1000 });
    out.push(...r.blobs);
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  return out;
}

export async function putJson(pathname, data) {
  return put(pathname, JSON.stringify(data), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 31536000,
  });
}

export async function readJson(pathname) {
  const r = await list({ prefix: pathname, limit: 10 });
  const blob = r.blobs.find((b) => b.pathname === pathname);
  if (!blob) return null;
  const res = await fetch(blob.url, { cache: 'no-store' });
  if (!res.ok) return null;
  return res.json();
}

export function casePath(id) {
  return `c/${id}.json`;
}

/**
 * Moderation state lives in its own blob rather than inside the case, because
 * the case blob is written once at filing time and two writers would clobber
 * each other. Absent state means a normal, visible case.
 */
export function statePath(id) {
  return `c/${id}/state.json`;
}

export function caseReportPath(id, fp) {
  return `c/${id}/cr/${fp}.json`;
}

export async function readState(id) {
  try {
    const s = await readJson(statePath(id));
    return { closed: false, stripped: false, ...(s || {}) };
  } catch {
    return { closed: false, stripped: false };
  }
}

/**
 * Strips the attachment and, if the case is closed, the evidence too. Used by
 * every path that hands a case to a reader: the API, the preview card and the
 * server rendered page.
 */
export function applyState(kase, state) {
  if (!kase) return kase;
  const out = { ...kase };
  if (state.stripped) {
    delete out.link;
    delete out.image;
  }
  if (state.closed) {
    out.closed = true;
    delete out.link;
    delete out.image;
  }
  return out;
}

const UPLOAD_RE = /^[23456789abcdefghjmnpqrstuvwxyz]{14}\.(jpg|png|webp)$/;

export function isValidUploadId(v) {
  return typeof v === 'string' && UPLOAD_RE.test(v);
}

export function uploadPath(uploadId) {
  return `u/${uploadId}`;
}

export async function blobUrl(pathname) {
  const r = await list({ prefix: pathname, limit: 10 });
  const blob = r.blobs.find((b) => b.pathname === pathname);
  return blob ? blob.url : null;
}

/**
 * Vote pathname carries everything needed to count, so aggregating a case
 * costs one list() and zero content fetches. Only commented votes get read.
 *   c/<caseId>/v/<ts36>~<voteId>~<choice>~<prediction>~<c|n>.json
 */
export function votePath(caseId, ts, voteId, choice, prediction, hasComment, choice2) {
  const t = ts.toString(36).padStart(9, '0');
  const c2 = Number.isInteger(choice2) && choice2 >= 0 ? choice2 : 'x';
  return `c/${caseId}/v/${t}~${voteId}~${choice}~${prediction}~${hasComment ? 'c' : 'n'}~${c2}.json`;
}

/**
 * Votes filed before the second question existed have five segments rather
 * than six. They are still valid votes, so a missing segment means "did not
 * answer" instead of a parse failure.
 */
export function parseVotePath(pathname) {
  const name = pathname.split('/').pop().replace(/\.json$/, '');
  const [ts, voteId, choice, prediction, flag, choice2] = name.split('~');
  const c = Number(choice);
  const p = Number(prediction);
  if (!voteId || !Number.isInteger(c) || !Number.isInteger(p)) return null;
  const c2 = choice2 === undefined || choice2 === 'x' ? -1 : Number(choice2);
  return {
    ts,
    voteId,
    choice: c,
    prediction: p,
    hasComment: flag === 'c',
    choice2: Number.isInteger(c2) ? c2 : -1,
  };
}

/**
 * Reads every vote for a case and folds it into the result payload.
 * Nothing here is ever sent to a browser that has not recorded a vote.
 */
export async function aggregate(caseId, kase, opts = {}) {
  const [voteBlobs, hiddenBlobs, reportBlobs] = await Promise.all([
    listAll(`c/${caseId}/v/`),
    listAll(`c/${caseId}/x/`),
    listAll(`c/${caseId}/r/`),
  ]);

  const hidden = new Set(
    hiddenBlobs.map((b) => b.pathname.split('/').pop().replace(/\.json$/, ''))
  );

  const reportCounts = new Map();
  for (const b of reportBlobs) {
    const target = b.pathname.split('/').pop().replace(/\.json$/, '').split('~')[0];
    reportCounts.set(target, (reportCounts.get(target) || 0) + 1);
  }

  const counts = new Array(kase.options.length).fill(0);
  const q2opts = kase.q2?.options?.length || 0;
  const counts2 = new Array(q2opts).fill(0);
  let total2 = 0;
  const votes = [];
  for (const b of voteBlobs) {
    const v = parseVotePath(b.pathname);
    if (!v || v.choice < 0 || v.choice >= counts.length) continue;
    counts[v.choice] += 1;
    if (q2opts && v.choice2 >= 0 && v.choice2 < q2opts) {
      counts2[v.choice2] += 1;
      total2 += 1;
    }
    votes.push({ ...v, url: b.url });
  }

  const total = votes.length;
  const percents = counts.map((n) => (total ? Math.round((n / total) * 100) : 0));
  // Percentages for the second question are out of the people who answered it,
  // not out of everyone, since older votes predate the question entirely.
  const percents2 = counts2.map((n) => (total2 ? Math.round((n / total2) * 100) : 0));

  // Newest first. ts36 is zero padded so a plain string sort is chronological.
  votes.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));

  const commented = votes
    .filter((v) => v.hasComment && !hidden.has(v.voteId))
    .slice(0, 200);

  const comments = (
    await Promise.all(
      commented.map(async (v) => {
        const reports = reportCounts.get(v.voteId) || 0;
        if (reports >= REPORT_THRESHOLD && !opts.isHost) return null;
        try {
          const res = await fetch(v.url, { cache: 'no-store' });
          if (!res.ok) return null;
          const body = await res.json();
          const text = clean(body.t, 500);
          if (!text) return null;
          return { id: v.voteId, choice: v.choice, text, reports, ts: v.ts };
        } catch {
          return null;
        }
      })
    )
  ).filter(Boolean);

  const out = { total, counts, percents, comments };
  if (q2opts) {
    out.counts2 = counts2;
    out.percents2 = percents2;
    out.total2 = total2;
  }

  // Lets a returning voter be re-identified from their own vote id without
  // storing anything extra. Their answers and prediction are in the pathname.
  if (opts.voteId) {
    const mine = votes.find((v) => v.voteId === opts.voteId);
    out.you = mine
      ? { choice: mine.choice, prediction: mine.prediction, choice2: mine.choice2 }
      : null;
  }

  return out;
}

export function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}

export function fail(res, status, message, extra = {}) {
  res.status(status).json({ ok: false, error: message, ...extra });
}
