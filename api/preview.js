import { lookup } from 'node:dns/promises';
import { clean, fail } from './_lib.js';

/**
 * Fetches the title, site name and thumbnail for a pasted link.
 *
 * This endpoint takes a URL from the public and asks our server to fetch it,
 * which is the classic shape of a server side request forgery hole. Everything
 * below is there to stop this being used as a proxy into anything that trusts
 * our egress: the runtime API on loopback, cloud metadata on 169.254.169.254,
 * or anything else not on the public internet.
 *
 * Residual risk, stated plainly: a hostname could resolve to a public address
 * during the check and a private one microseconds later when fetch connects
 * (DNS rebinding). Closing that needs a custom agent that pins the socket to
 * the address we validated, which is more machinery than a link preview earns.
 * The blast radius here is a page title, and nothing is echoed back raw.
 */

const FETCH_TIMEOUT_MS = 6000;
const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;

/**
 * Separated from ordinary failure on purpose. A page that will not load is
 * still a link worth attaching, but an address we refused to touch must not
 * come back as an attachable link.
 */
class Blocked extends Error {}

function ipv4Private(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;           // link local and cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier grade NAT
  if (a >= 224) return true;                          // multicast and reserved
  return false;
}

function ipPrivate(ip, family) {
  if (family === 4) return ipv4Private(ip);
  const v = String(ip).toLowerCase();
  if (v === '::' || v === '::1') return true;
  if (v.startsWith('fc') || v.startsWith('fd')) return true; // unique local
  if (v.startsWith('fe80')) return true;                     // link local
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);   // v4 in v6
  if (mapped) return ipv4Private(mapped[1]);
  return false;
}

async function assertPublic(hostname) {
  let records;
  try {
    records = await lookup(hostname, { all: true });
  } catch {
    throw new Blocked('That address does not resolve.');
  }
  if (!records.length) throw new Blocked('That address does not resolve.');
  for (const r of records) {
    if (ipPrivate(r.address, r.family)) throw new Blocked('That address is not on the public internet.');
  }
}

function parseSafeUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Blocked('That does not look like a link.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Blocked('Only http and https links work here.');
  }
  if (u.username || u.password) throw new Blocked('Leave credentials out of the link.');
  return u;
}

/**
 * Bare domains get https:// added. Anything carrying its own scheme keeps it,
 * so file: and gopher: are refused outright rather than being bolted onto
 * https:// and turned into a nonsense host.
 */
function normalise(raw) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
  return `https://${raw}`;
}

async function fetchHtml(startUrl) {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublic(url.hostname);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url.href, {
        redirect: 'manual',
        signal: ac.signal,
        headers: {
          // Identify honestly and ask for html only.
          'User-Agent': 'ThePublicInquiry/1.0 (+https://thepublicinquiry.vercel.app)',
          Accept: 'text/html,application/xhtml+xml',
        },
      });
    } finally {
      clearTimeout(timer);
    }

    // Every hop is re-validated, because a public host can redirect inward.
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error('That link goes nowhere.');
      url = parseSafeUrl(new URL(loc, url).href);
      continue;
    }

    if (!res.ok) throw new Error('That page did not load.');
    const type = res.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml/i.test(type)) {
      return { url, html: '' }; // not a page we can read, still a valid link
    }

    // Read a bounded number of bytes so a huge page cannot exhaust the function.
    const reader = res.body?.getReader();
    if (!reader) return { url, html: '' };
    const chunks = [];
    let size = 0;
    while (size < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    try { await reader.cancel(); } catch {}
    const html = new TextDecoder('utf-8').decode(
      chunks.length === 1 ? chunks[0] : Buffer.concat(chunks.map((c) => Buffer.from(c)))
    );
    return { url, html };
  }
  throw new Error('That link redirects too many times.');
}

function metaFrom(html, names) {
  for (const name of names) {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)\\s*=\\s*["']${name}["'][^>]*>`,
      'i'
    );
    const tag = html.match(re)?.[0];
    if (!tag) continue;
    const content = tag.match(/content\s*=\s*["']([^"']*)["']/i)?.[1];
    if (content) return decodeEntities(content);
  }
  return '';
}

function decodeEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** YouTube and Vimeo get a real player. Everything else gets a link card. */
export function detectEmbed(u) {
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    if (/^[\w-]{6,20}$/.test(id)) return { provider: 'youtube', id };
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    const id = u.searchParams.get('v') || u.pathname.match(/\/(?:embed|shorts|live)\/([\w-]{6,20})/)?.[1];
    if (id && /^[\w-]{6,20}$/.test(id)) return { provider: 'youtube', id };
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const id = u.pathname.match(/(\d{6,12})/)?.[1];
    if (id) return { provider: 'vimeo', id };
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return fail(res, 405, 'Method not allowed.');
  }

  const raw = clean(req.query?.url, 600);
  if (!raw) return fail(res, 400, 'Paste a link first.');

  let u;
  try {
    u = parseSafeUrl(normalise(raw));
  } catch (err) {
    return fail(res, 400, err.message);
  }

  const embed = detectEmbed(u);

  let html = '';
  let finalUrl = u;
  try {
    const r = await fetchHtml(u);
    html = r.html;
    finalUrl = r.url;
  } catch (err) {
    // An address we refused to touch is refused outright, so it never comes
    // back as something the filer can attach.
    if (err instanceof Blocked) return fail(res, 400, err.message);

    // Anything else is just a page that would not load. That is still a link
    // worth attaching, so degrade to the bare minimum rather than blocking it.
    return res.status(200).json({
      ok: true,
      url: u.href,
      site: u.hostname.replace(/^www\./, ''),
      title: '',
      image: '',
      embed,
      note: 'That page would not open, so the link is attached as it is.',
    });
  }

  const title =
    metaFrom(html, ['og:title', 'twitter:title']) ||
    decodeEntities(html.match(/<title[^>]*>([^<]{1,300})<\/title>/i)?.[1] || '');
  const site = metaFrom(html, ['og:site_name']) || finalUrl.hostname.replace(/^www\./, '');
  let image = metaFrom(html, ['og:image:secure_url', 'og:image', 'twitter:image']);

  // Only keep an absolute https thumbnail. A relative or http one is not worth
  // the mixed content warning.
  if (image) {
    try {
      const abs = new URL(image, finalUrl.href);
      image = abs.protocol === 'https:' ? abs.href : '';
    } catch {
      image = '';
    }
  }

  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600');
  return res.status(200).json({
    ok: true,
    url: finalUrl.href,
    title: clean(title, 200),
    site: clean(site, 80),
    image: clean(image, 600),
    embed,
  });
}
