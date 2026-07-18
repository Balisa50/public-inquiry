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
 * Vote pathname carries everything needed to count, so aggregating a case
 * costs one list() and zero content fetches. Only commented votes get read.
 *   c/<caseId>/v/<ts36>~<voteId>~<choice>~<prediction>~<c|n>.json
 */
export function votePath(caseId, ts, voteId, choice, prediction, hasComment) {
  const t = ts.toString(36).padStart(9, '0');
  return `c/${caseId}/v/${t}~${voteId}~${choice}~${prediction}~${hasComment ? 'c' : 'n'}.json`;
}

export function parseVotePath(pathname) {
  const name = pathname.split('/').pop().replace(/\.json$/, '');
  const [ts, voteId, choice, prediction, flag] = name.split('~');
  const c = Number(choice);
  const p = Number(prediction);
  if (!voteId || !Number.isInteger(c) || !Number.isInteger(p)) return null;
  return { ts, voteId, choice: c, prediction: p, hasComment: flag === 'c' };
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
  const votes = [];
  for (const b of voteBlobs) {
    const v = parseVotePath(b.pathname);
    if (!v || v.choice < 0 || v.choice >= counts.length) continue;
    counts[v.choice] += 1;
    votes.push({ ...v, url: b.url });
  }

  const total = votes.length;
  const percents = counts.map((n) => (total ? Math.round((n / total) * 100) : 0));

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

  // Lets a returning voter be re-identified from their own vote id without
  // storing anything extra. Their choice and prediction are in the pathname.
  if (opts.voteId) {
    const mine = votes.find((v) => v.voteId === opts.voteId);
    out.you = mine ? { choice: mine.choice, prediction: mine.prediction } : null;
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
