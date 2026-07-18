import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ID_LEN, clean, isValidId, readJson, readState, casePath } from './_lib.js';

/**
 * Serves the app at /c/<caseId> with the preview tags filled in for that case.
 *
 * This route exists because a hash fragment never reaches the server, so a
 * <site>/#<caseId> link can only ever produce one generic preview card for
 * every case ever filed. Links spread through group chats, and the preview is
 * most of what makes somebody tap. So the share link is a real path.
 *
 * Nothing about the tally is exposed here. The crawler and the reader both get
 * the question and the options, which is exactly what /api/case already serves.
 */

let TEMPLATE = null;
function template() {
  if (TEMPLATE === null) {
    TEMPLATE = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
  }
  return TEMPLATE;
}

function attr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export default async function handler(req, res) {
  const id = clean(req.query?.id, ID_LEN).toLowerCase();

  let html;
  try {
    html = template();
  } catch (err) {
    // If the template is missing the app is broken anyway, but say so plainly.
    res.status(500).send('The registry is closed. Try again shortly.');
    return;
  }

  let kase = null;
  if (isValidId(id)) {
    try {
      const [k, state] = await Promise.all([readJson(casePath(id)), readState(id)]);
      // A closed case gets the generic tags, so a takedown also stops the
      // preview rendering everywhere the link was already pasted.
      if (k && !state.closed) kase = k;
    } catch {
      // A slow registry should still return a usable page.
    }
  }

  if (kase) {
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'thepublicinquiry.vercel.app';
    const base = `https://${host}`;
    const title = `${kase.question} | The Public Inquiry`;
    const desc = String(kase.evidence).slice(0, 160);
    const tags = [
      `<title>${attr(title)}</title>`,
      `<meta name="description" content="${attr(desc)}">`,
      `<meta property="og:title" content="${attr(kase.question)}">`,
      `<meta property="og:description" content="${attr(desc)}">`,
      `<meta property="og:type" content="website">`,
      `<meta property="og:url" content="${base}/c/${id}">`,
      `<meta property="og:image" content="${base}/api/og?id=${id}">`,
      `<meta property="og:image:width" content="1200">`,
      `<meta property="og:image:height" content="630">`,
      `<meta name="twitter:card" content="summary_large_image">`,
      `<meta name="twitter:title" content="${attr(kase.question)}">`,
      `<meta name="twitter:description" content="${attr(desc)}">`,
      `<meta name="twitter:image" content="${base}/api/og?id=${id}">`,
    ].join('\n');
    html = html.replace(/<!--OG-->[\s\S]*?<!--\/OG-->/, tags);
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=600');
  res.status(200).send(html);
}
