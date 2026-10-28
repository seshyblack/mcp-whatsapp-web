import sharp from 'sharp';
import type { AuctionDigestLot } from './auction.js';
import { formatMYR } from './auction.js';

const W = 1080;
const H = 1350;
const ink = '#292822';
const muted = '#756f64';
const paper = '#f4f1eb';
const panel = '#e9e4d9';
const line = '#d3cabd';
const accent = '#7b6a53';

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function wrapLabel(value: string, max = 21): string[] {
  const words = value.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  for (const word of words) {
    if (!lines.length || (lines[lines.length - 1]!.length + word.length + 1 > max)) lines.push(word);
    else lines[lines.length - 1] += ' ' + word;
  }
  return lines.slice(0, 3);
}

function allowedRemoteImage(value?: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase();
    return host === 'calmistry.space' || host === 'www.calmistry.space'
      || host.endsWith('.fbcdn.net') || host.endsWith('.fbsbx.com');
  } catch { return false; }
}

async function embeddedImage(url?: string): Promise<string | null> {
  if (!allowedRemoteImage(url)) return null;
  try {
    const response = await fetch(url!, { signal: AbortSignal.timeout(6500), redirect: 'error' });
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
    if (!response.ok || !['image/jpeg', 'image/png', 'image/webp'].includes(type)) return null;
    if (Number(response.headers.get('content-length')) > 4_000_000) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 4_000_000) return null;
    const jpeg = await sharp(buffer, { limitInputPixels: 12_000_000 }).resize(178, 195, { fit: 'cover' }).jpeg({ quality: 76 }).toBuffer();
    return 'data:image/jpeg;base64,' + jpeg.toString('base64');
  } catch { return null; }
}

function card(lot: AuctionDigestLot, index: number, photo: string | null): string {
  const x = index % 2 === 0 ? 56 : 552;
  const y = 278 + Math.floor(index / 2) * 306;
  const textX = x + 210;
  const lines = wrapLabel(lot.name);
  const title = lines.map((v, i) => '<text x="' + textX + '" y="' + (y + 65 + i * 27) +
    '" fill="' + ink + '" font-family="Georgia,serif" font-size="24">' + escapeXml(v) + '</text>').join('');
  const cover = photo
    ? '<image x="' + (x + 22) + '" y="' + (y + 25) + '" width="177" height="192" href="' + photo + '" preserveAspectRatio="xMidYMid slice"/>'
    : '<rect x="' + (x + 22) + '" y="' + (y + 25) + '" width="177" height="192" fill="' + panel + '"/><text x="' +
      (x + 110) + '" y="' + (y + 125) + '" text-anchor="middle" fill="' + muted + '" font-size="20" font-family="Georgia">Calmistry</text>';
  const highest = lot.highestCents == null ? 'NO BIDS YET' : formatMYR(lot.highestCents);
  return '<rect x="' + x + '" y="' + y + '" width="472" height="282" rx="2" fill="#fffcf8" stroke="' + line + '"/>' +
    cover +
    '<text x="' + textX + '" y="' + (y + 35) + '" fill="' + accent + '" font-size="13" letter-spacing="1.3" font-family="Arial,sans-serif">LOT ' +
      'CALMISTRY AUCTION' + '</text>' + title +
    '<text x="' + textX + '" y="' + (y + 167) + '" fill="' + muted + '" font-size="14" font-family="Arial,sans-serif">OPENING BID</text>' +
    '<text x="' + textX + '" y="' + (y + 193) + '" fill="' + ink + '" font-size="24" font-family="Arial,sans-serif">' +
      escapeXml(formatMYR(lot.openingCents)) + '</text>' +
    '<text x="' + textX + '" y="' + (y + 222) + '" fill="' + muted + '" font-size="14" font-family="Arial,sans-serif">HIGHEST BID</text>' +
    '<text x="' + textX + '" y="' + (y + 249) + '" fill="' + accent + '" font-size="23" font-weight="bold" font-family="Arial,sans-serif">' +
      escapeXml(highest) + '</text>' +
    '<line x1="' + (x + 22) + '" y1="' + (y + 238) + '" x2="' + (x + 198) + '" y2="' + (y + 238) + '" stroke="' + line + '"/>' +
    '<text x="' + (x + 22) + '" y="' + (y + 260) + '" fill="' + muted + '" font-size="13" font-family="Arial,sans-serif">' +
      (lot.bidCount ? lot.bidCount + ' confirmed bids' : 'Opening bid available') + '</text>';
}

export async function renderAuctionDigest(lots: AuctionDigestLot[], updatedAt = new Date()): Promise<Buffer> {
  if (!lots.length) throw new Error('No auction lots available for the hourly graphic.');
  // A single carefully laid out Channel post, rather than one notification per product.
  const shown = lots.slice(0, 6);
  const images = await Promise.all(shown.map(lot => embeddedImage(lot.imageUrl)));
  const datestamp = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kuala_Lumpur', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  }).format(updatedAt).toUpperCase();
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">',
    '<rect width="1080" height="1350" fill="' + paper + '"/>',
    '<text x="55" y="91" fill="' + ink + '" font-family="Georgia,serif" font-size="63" letter-spacing="5">CALMISTRY</text>',
    '<text x="55" y="135" fill="' + muted + '" font-family="Arial,sans-serif" font-size="18" letter-spacing="5">RATTAN STUDIO</text>',
    '<line x1="55" y1="167" x2="1025" y2="167" stroke="' + accent + '"/>',
    '<text x="55" y="218" fill="' + ink + '" font-family="Georgia,serif" font-size="33">Private Auction | Latest Bids</text>',
    '<text x="1024" y="253" text-anchor="end" fill="' + muted + '" font-family="Arial,sans-serif" font-size="17">' + escapeXml(datestamp) + ' MYT</text>',
    ...shown.map((lot, i) => card(lot, i, images[i])),
    '<line x1="55" y1="1231" x2="1025" y2="1231" stroke="' + accent + '"/>',
    '<text x="55" y="1273" fill="' + ink + '" font-family="Arial,sans-serif" font-size="18" letter-spacing="1">TO BID: SHARE YOUR CHOSEN CATALOGUE ITEM IN A PRIVATE CHAT</text>',
    '<text x="55" y="1306" fill="' + muted + '" font-family="Arial,sans-serif" font-size="17">Opening bids stay in the catalogue. Highest bids shown here are confirmed.</text>',
    '</svg>',
  ].join('');
  return sharp(Buffer.from(svg)).jpeg({ quality: 88, chromaSubsampling: '4:4:4' }).toBuffer();
}
