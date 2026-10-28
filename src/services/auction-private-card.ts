import sharp from 'sharp';
import type { AuctionDigestLot, PrivateNoticeKind } from './auction.js';
import { formatMYR } from './auction.js';

const C = {
  paper: '#f4f0e8', ink: '#2c2b26', muted: '#746f65',
  rattan: '#90785b', edge: '#d8d0c1', field: '#e5dfd2',
};
function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function wrap(s: string, maxLength = 29): string[] {
  const output: string[] = [];
  for (const word of s.trim().replace(/\s+/g, ' ').split(' ')) {
    if (!output.length || output[output.length - 1]!.length + word.length + 1 > maxLength) output.push(word);
    else output[output.length - 1] += ' ' + word;
  }
  return output.slice(0, 3);
}
async function photoData(url?: string): Promise<string | null> {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:' || parsed.port || parsed.username || parsed.password ||
       !(host === 'calmistry.space' || host === 'www.calmistry.space' ||
         host.endsWith('.fbcdn.net') || host.endsWith('.fbsbx.com'))) return null;
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok || !['image/jpeg', 'image/png', 'image/webp'].includes(
      (response.headers.get('content-type') || '').split(';')[0]!.toLowerCase())) return null;
    if (Number(response.headers.get('content-length')) > 4_000_000) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 4_000_000) return null;
    const jpeg = await sharp(bytes, { limitInputPixels: 12_000_000 }).resize(470, 540, { fit: 'cover' }).jpeg({ quality: 80 }).toBuffer();
    return 'data:image/jpeg;base64,' + jpeg.toString('base64');
  } catch { return null; }
}

export async function renderPrivateBidCard(lot: AuctionDigestLot, kind: PrivateNoticeKind, amountCents?: number): Promise<Buffer> {
  const photo = await photoData(lot.imageUrl);
  const heading = kind === 'leading' ? 'YOU ARE CURRENTLY LEADING'
    : kind === 'outbid' ? 'BIDDING HAS MOVED'
      : kind === 'reminder_1h' ? 'FINAL HOUR'
        : kind === 'reminder_24h' ? 'CLOSING TOMORROW'
          : 'ACTIVE BIDDING';
  const subtitle = kind === 'leading' ? 'YOUR CONFIRMED BID'
    : kind === 'outbid' ? 'A REVISED BID IS WELCOME'
      : kind === 'activity' ? 'PRIVATE AUCTION UPDATE'
        : 'A PRIVATE REMINDER';
  const relevantAmount = kind === 'leading' && amountCents ? formatMYR(amountCents) : null;
  const nameLines = wrap(lot.name);
  const title = nameLines.map((line, i) => '<text x="75" y="' + (310 + i * 55) +
    '" font-size="45" font-family="Georgia,serif" fill="' + C.ink + '">' + escapeXml(line) + '</text>').join('');
  const photoArea = photo
    ? '<image x="552" y="245" width="455" height="540" preserveAspectRatio="xMidYMid slice" href="' + photo + '"/>'
    : '<rect x="552" y="245" width="455" height="540" fill="' + C.field + '"/>' +
      '<text x="780" y="505" font-size="34" font-family="Georgia,serif" fill="' + C.rattan +
      '" text-anchor="middle">CALMISTRY</text>' +
      '<text x="780" y="546" font-size="22" font-family="Arial,sans-serif" fill="' + C.muted +
      '" text-anchor="middle">RATTAN STUDIO</text>';
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">',
    '<rect width="1080" height="1080" fill="' + C.paper + '"/>',
    '<rect x="42" y="42" width="996" height="996" fill="none" stroke="' + C.edge + '"/>',
    '<text x="75" y="134" font-family="Georgia,serif" letter-spacing="6" font-size="62" fill="' + C.ink + '">CALMISTRY</text>',
    '<text x="75" y="173" font-family="Arial,sans-serif" letter-spacing="4" font-size="17" fill="' + C.rattan + '">PRIVATE RATTAN AUCTION</text>',
    '<line x1="75" x2="1005" y1="202" y2="202" stroke="' + C.rattan + '"/>',
    title,
    '<text x="75" y="610" font-family="Arial,sans-serif" font-size="19" letter-spacing="2" fill="' + C.muted + '">OPENING BID</text>',
    '<text x="75" y="658" font-family="Georgia,serif" font-size="42" fill="' + C.ink + '">' + escapeXml(formatMYR(lot.openingCents)) + '</text>',
    '<text x="75" y="730" font-family="Arial,sans-serif" font-size="19" letter-spacing="1.5" fill="' + C.muted + '">' + escapeXml(subtitle) + '</text>',
    relevantAmount ? '<text x="75" y="784" font-family="Georgia,serif" font-size="49" fill="' + C.rattan + '">' + escapeXml(relevantAmount) + '</text>' : '',
    photoArea,
    '<line x1="75" x2="1005" y1="855" y2="855" stroke="' + C.rattan + '"/>',
    '<text x="75" y="917" font-family="Georgia,serif" font-size="37" fill="' + C.ink + '">' + escapeXml(heading) + '</text>',
    '<text x="75" y="971" font-family="Arial,sans-serif" font-size="19" fill="' + C.muted + '">A PRIVATE UPDATE FOR THIS PIECE ONLY</text>',
    '</svg>',
  ].join('');
  return sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
}
