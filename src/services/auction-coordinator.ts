import path from 'node:path';
import { AuctionBook, type AuctionLot, type AuctionDigestLot } from './auction.js';
import { renderAuctionDigest } from './auction-poster.js';
import type { SimpleMessage, WhatsAppBackend } from './backend.js';
import { WhatsAppCatalog } from './catalog.js';
import { log } from '../utils/logger.js';

export interface AuctionConfiguration {
  enabled: boolean;
  autoAcknowledge: boolean;
  channelPostEnabled: boolean;
  channelJid?: string;
  channelName?: string;
  termsUrl?: string;
  closeAt: string;
  databaseFile: string;
}

export function auctionConfiguration(env: NodeJS.ProcessEnv = process.env): AuctionConfiguration {
  const closeAt = env.AUCTION_END_AT ?? '2026-11-24T11:00:00+08:00';
  if (!Number.isFinite(Date.parse(closeAt))) throw new Error('AUCTION_END_AT must be an ISO date with timezone.');
  const channelJid = env.AUCTION_CHANNEL_JID?.trim();
  if (channelJid && !/^\d+@newsletter$/.test(channelJid)) throw new Error('AUCTION_CHANNEL_JID must be a confirmed @newsletter ID.');
  return {
    enabled: env.AUCTION_ENABLED === 'true',
    autoAcknowledge: env.AUCTION_AUTO_ACK_ENABLED === 'true',
    channelPostEnabled: env.AUCTION_CHANNEL_POST_ENABLED === 'true',
    channelJid,
    channelName: env.AUCTION_CHANNEL_NAME,
    termsUrl: env.AUCTION_TERMS_URL,
    closeAt,
    databaseFile: env.AUCTION_DB_PATH || path.join(env.BAILEYS_SESSION_DIR || path.join(process.cwd(), 'baileys-sessions'), 'calmistry-auction.sqlite'),
  };
}

export function bidMessageId(id: string): string | null {
  if (!id.startsWith('b1:')) return null;
  try {
    const raw = JSON.parse(Buffer.from(id.slice(3), 'base64url').toString('utf8')) as { id?: unknown };
    return typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : null;
  } catch { return null; }
}

export class AuctionCoordinator {
  readonly book: AuctionBook;
  readonly config: AuctionConfiguration;
  private unsubscribe?: () => void;
  private timer?: NodeJS.Timeout;
  private serialized: Promise<void> = Promise.resolve();

  constructor(private readonly whatsapp: WhatsAppBackend, config = auctionConfiguration()) {
    this.config = config;
    this.book = new AuctionBook(config.databaseFile, config.termsUrl ?? '', Date.parse(config.closeAt));
  }

  start(): void {
    if (this.config.enabled && this.config.autoAcknowledge && !this.config.termsUrl) {
      log.warn('Auction auto-acknowledgements remain disabled: AUCTION_TERMS_URL is missing.');
    } else if (this.config.enabled && this.config.autoAcknowledge && this.whatsapp.onIncomingMessage) {
      this.unsubscribe = this.whatsapp.onIncomingMessage(message => {
        this.serialized = this.serialized.then(() => this.onIncoming(message)).catch(error => {
          log.error('Auction bid processing failed; manual review required:', error);
        });
      });
    }
    if (this.config.enabled && this.config.channelPostEnabled && this.config.channelJid) this.scheduleHour();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.book.close();
  }

  private async onIncoming(message: SimpleMessage): Promise<void> {
    const stanzaId = bidMessageId(message.id);
    if (!stanzaId) return;
    const result = this.book.handle({
      chatId: message.chatId ?? '',
      stanzaId, body: message.body, type: message.type,
      productId: message.productId,
      quotedStanzaId: message.quotedMessage?.stanzaId,
      quotedText: message.quotedMessage?.text,
      receivedAt: Date.now(), fromMe: message.fromMe,
    });
    if (!result.reply) return;
    // Send only for explicit bid attempts/terms acceptance, never for ordinary messages or catalogue browsing.
    // Never automatically retry an uncertain WhatsApp send.
    await this.whatsapp.sendMessage(message.chatId!, result.reply);
  }

  addLots(lots: AuctionLot[]): number { return this.book.upsertLots(lots); }
  summary() {
    return {
      active: this.config.enabled,
      autoAcknowledgements: this.config.enabled && this.config.autoAcknowledge && !!this.config.termsUrl && !!this.whatsapp.onIncomingMessage,
      channelPublishing: this.config.enabled && this.config.channelPostEnabled && !!this.config.channelJid,
      channelConfigured: !!this.config.channelJid,
      closeAt: this.config.closeAt,
      lotCount: this.book.digest().length,
      confirmedBidCount: this.book.bidCount(),
      note: 'This does not enable auction bids or public posts until explicitly configured and tested.',
    };
  }

  async importFromVerifiedCatalogue(catalog = new WhatsAppCatalog()): Promise<{ imported: number; skipped: string[] }> {
    // Only accept explicit MYR decimal amounts; never guess whether an integer means cents.
    const response = await catalog.listProducts(100) as { data?: Array<Record<string, unknown>> };
    const products = Array.isArray(response.data) ? response.data : [];
    const lots: AuctionLot[] = [];
    const skipped: string[] = [];
    for (const product of products) {
      const name = String(product.name ?? product.title ?? '').trim();
      const id = String(product.id ?? '');
      const quotedPrice = product.price;
      const fromObject = quotedPrice && typeof quotedPrice === 'object'
        ? quotedPrice as { amount?: unknown; currency?: unknown } : null;
      const fromText = typeof quotedPrice === 'string'
        ? quotedPrice.match(/^([0-9]+(?:\.[0-9]{1,2})?)\s+MYR$/) : null;
      const rawAmount = fromObject?.currency === 'MYR' ? fromObject.amount : fromText?.[1];
      const value = typeof rawAmount === 'string' || typeof rawAmount === 'number' ? Number(rawAmount) : NaN;
      if (!/^\d{5,30}$/.test(id) || !name || /TEST\s+ONLY/i.test(name) || !Number.isFinite(value) || value <= 0) {
        skipped.push(name || id || '[unnamed]');
        continue;
      }
      lots.push({ productId: id, name, openingCents: Math.round(value * 100), currency: 'MYR',
        imageUrl: typeof product.image_url === 'string' ? product.image_url : undefined });
    }
    return { imported: this.book.upsertLots(lots), skipped };
  }

  /** Render branded visual for inspection. Never sends or publishes. */
  async preview(): Promise<{ image: Buffer; count: number; total: number; lots: AuctionDigestLot[] }> {
    const all = this.book.digest();
    const shown = this.featuredLots(all);
    if (!shown.length) throw new Error('No auction lots. Import approved products with their opening bids first.');
    return { image: await renderAuctionDigest(shown), count: shown.length, total: all.length, lots: shown };
  }

  private featuredLots(all: AuctionDigestLot[], timestamp = Date.now()): AuctionDigestLot[] {
    if (all.length <= 6) return all;
    // One polished Channel image per hour: rotate through product pages rather than spam the Channel.
    const page = Math.floor(timestamp / 3_600_000) % Math.ceil(all.length / 6);
    return all.slice(page * 6, page * 6 + 6);
  }

  async publishHour(now = new Date()): Promise<{ status: string; count?: number; messageId?: string }> {
    if (!this.config.enabled || !this.config.channelPostEnabled || !this.config.channelJid) return { status: 'disabled' };
    if (now.getTime() >= Date.parse(this.config.closeAt) + 15 * 60_000) return { status: 'closed' };
    const all = this.book.digest();
    if (!all.length) return { status: 'no_lots' };
    const slot = now.toISOString().slice(0, 13);
    if (!this.book.claimPost(slot, now.getTime())) return { status: 'already_attempted' };
    try {
      const selected = this.featuredLots(all, now.getTime());
      const image = await renderAuctionDigest(selected, now);
      const caption = 'CALMISTRY | PRIVATE AUCTION\n' +
        'Opening bids are shown in the catalogue. This graphic shows the highest confirmed bids as at ' +
        new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', minute: '2-digit' }).format(now) +
        ' MYT. To bid, share the catalogue item in a private WhatsApp chat.\nNo bidder identities or reserve prices are disclosed.';
      const receipt = await this.whatsapp.sendMediaFromBase64(this.config.channelJid, image.toString('base64'), 'image/jpeg',
        'calmistry-auction-hourly.jpg', caption);
      this.book.completePost(slot, receipt.id);
      return { status: 'sent', count: selected.length, messageId: receipt.id };
    } catch (error) {
      // Some Baileys versions report media delivery failures for Channels. Never send a duplicate on a timer.
      this.book.uncertainPost(slot, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private scheduleHour(): void {
    const wait = 3_600_000 - (Date.now() % 3_600_000) + 1500; // Malaysia is UTC+8, so hour boundaries coincide.
    this.timer = setTimeout(() => {
      this.publishHour().catch(error => log.error('Hourly Channel graphic requires attention:', error))
        .finally(() => this.scheduleHour());
    }, wait);
    this.timer.unref?.();
  }
}
