import { ImageResponse } from '@vercel/og';

/**
 * The preview card every shared link renders in a group chat.
 *
 * Runs on the edge and reads the case through the public /api/case endpoint
 * rather than touching storage directly, so it can never leak a field that the
 * commitment gate does not already serve to a reader who has not voted.
 */
export const config = { runtime: 'edge' };

const PAPER = '#F2EEE3';
const INK = '#16130E';
const ACCENT = '#B02418';
const MUTED = '#6E6656';

function el(type, style, children) {
  return { type, props: { style, children } };
}

/**
 * Google serves woff2 to modern clients and satori cannot read woff2, so ask
 * as an old browser and take the truetype it falls back to.
 */
async function loadFont(spec) {
  try {
    const css = await fetch(`https://fonts.googleapis.com/css2?family=${spec}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_6_8) AppleWebKit/533.20.25 (KHTML, like Gecko) Version/5.0.4 Safari/533.20.27',
      },
    }).then((r) => r.text());
    const m = css.match(/src:\s*url\(([^)]+)\)\s*format\('(?:truetype|opentype)'\)/);
    if (!m) return null;
    const res = await fetch(m[1]);
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

export default async function handler(req) {
  const url = new URL(req.url);
  const id = (url.searchParams.get('id') || '').trim().toLowerCase();

  let kase = null;
  if (/^[23456789abcdefghjmnpqrstuvwxyz]{8}$/.test(id)) {
    try {
      const r = await fetch(`${url.origin}/api/case?id=${id}`);
      if (r.ok) {
        const j = await r.json();
        if (j.ok) kase = j;
      }
    } catch {
      // Fall through to the generic card.
    }
  }

  const question = kase ? String(kase.question).slice(0, 110) : 'You file a case. The public rules on it.';
  const serial = kase ? kase.serial : 'THE PUBLIC INQUIRY';
  const options = kase ? kase.options.slice(0, 4) : ['Nobody can lurk'];
  const qSize = question.length > 74 ? 58 : question.length > 42 ? 72 : question.length > 20 ? 88 : 100;

  // A line of the actual story. Without it the card is all letterhead and no
  // hook, and the whole point is that somebody taps it in a group chat.
  let evidence = kase ? String(kase.evidence).replace(/\s+/g, ' ').trim() : '';
  if (evidence.length > 128) evidence = evidence.slice(0, 127).replace(/\s+\S*$/, '') + '...';

  const [serif, sans, sansBold] = await Promise.all([
    loadFont('Instrument+Serif'),
    loadFont('Space+Grotesk:wght@400'),
    loadFont('Space+Grotesk:wght@700'),
  ]);

  const fonts = [];
  if (serif) fonts.push({ name: 'Instrument Serif', data: serif, style: 'normal', weight: 400 });
  if (sans) fonts.push({ name: 'Space Grotesk', data: sans, style: 'normal', weight: 400 });
  if (sansBold) fonts.push({ name: 'Space Grotesk', data: sansBold, style: 'normal', weight: 700 });
  const serifFamily = serif ? 'Instrument Serif' : 'serif';
  const sansFamily = sans || sansBold ? 'Space Grotesk' : 'sans-serif';

  const tree = el(
    'div',
    {
      width: '1200px',
      height: '630px',
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: PAPER,
      color: INK,
      padding: '58px 64px',
      justifyContent: 'space-between',
    },
    [
      // masthead
      el('div', { display: 'flex', flexDirection: 'column' }, [
        el(
          'div',
          { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', width: '100%' },
          [
            el(
              'div',
              {
                fontFamily: sansFamily,
                fontSize: '20px',
                letterSpacing: '5px', fontWeight: 700,
                color: MUTED,
                display: 'flex',
              },
              'OFFICE OF PUBLIC OPINION'
            ),
            el(
              'div',
              { fontFamily: sansFamily, fontSize: '20px', letterSpacing: '3px', fontWeight: 700, color: MUTED, display: 'flex' },
              serial
            ),
          ]
        ),
        el('div', { display: 'flex', width: '100%', height: '4px', backgroundColor: INK, marginTop: '18px' }, []),
      ]),

      // the question
      el(
        'div',
        { display: 'flex', flexDirection: 'column', borderLeft: `10px solid ${ACCENT}`, paddingLeft: '30px' },
        [
          el('div', { fontFamily: serifFamily, fontSize: `${qSize}px`, lineHeight: 1.12, display: 'flex' }, question),
          ...(evidence
            ? [
                el(
                  'div',
                  {
                    fontFamily: sansFamily,
                    fontSize: '25px',
                    lineHeight: 1.42,
                    color: MUTED,
                    marginTop: '20px',
                    display: 'flex',
                    maxWidth: '900px',
                  },
                  evidence
                ),
              ]
            : []),
          el(
            'div',
            { display: 'flex', marginTop: '26px', flexWrap: 'wrap' },
            options.map((o, i) =>
              el(
                'div',
                {
                  fontFamily: sansFamily,
                  fontSize: '22px',
                  letterSpacing: '2px', fontWeight: 700,
                  color: INK,
                  border: `2px solid ${INK}`,
                  padding: '9px 16px',
                  marginRight: '12px',
                  marginTop: '10px',
                  display: 'flex',
                },
                String(o).slice(0, 22).toUpperCase()
              )
            )
          ),
        ]
      ),

      // footer with the stamp
      el(
        'div',
        { display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' },
        [
          el(
            'div',
            {
              fontFamily: sansFamily,
              fontSize: '26px',
              letterSpacing: '4px', fontWeight: 700,
              color: ACCENT,
              border: `5px solid ${ACCENT}`,
              padding: '12px 20px',
              transform: 'rotate(-4deg)',
              display: 'flex',
            },
            'SEALED UNTIL YOU RULE'
          ),
          el(
            'div',
            { fontFamily: sansFamily, fontSize: '22px', letterSpacing: '3px', fontWeight: 700, color: MUTED, display: 'flex' },
            'THEPUBLICINQUIRY.VERCEL.APP'
          ),
        ]
      ),
    ]
  );

  return new ImageResponse(tree, {
    width: 1200,
    height: 630,
    ...(fonts.length ? { fonts } : {}),
    headers: {
      'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
    },
  });
}
