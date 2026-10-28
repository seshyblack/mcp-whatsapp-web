import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { AuctionCoordinator } from '../services/auction-coordinator.js';

const answer = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});
const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const run = async (work: () => unknown | Promise<unknown>): Promise<CallToolResult> => {
  try { return answer(await work()); }
  catch (error) {
    return { ...answer({ error: error instanceof Error ? error.message : String(error) }), isError: true };
  }
};

export function registerAuctionTools(server: McpServer, auction: AuctionCoordinator): void {
  server.registerTool('auction_status', {
    description: 'Inspect the Calmistry private auction bid ledger and whether automatic acknowledgements and hourly Channel graphics are actually enabled. Does not change anything.',
    inputSchema: {}, annotations: read,
  }, () => run(() => auction.summary()));

  server.registerTool('auction_add_catalogue_lots', {
    description: 'Register Meta WhatsApp Catalogue products with verified opening bids as auction lots. Does not update Catalogue prices, send messages, or publish to the Channel. Existing opening bids are not overwritten.',
    inputSchema: {
      lots: z.array(z.object({
        productId: z.string().regex(/^\d{5,30}$/),
        name: z.string().min(1).max(150),
        openingCents: z.number().int().positive(),
        imageUrl: z.string().url().optional(),
        currency: z.literal('MYR'),
      })).min(1).max(100),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, ({ lots }) => run(() => ({ added: auction.addLots(lots), note: 'No posts or WhatsApp replies were sent.' })));

  server.registerTool('auction_import_verified_catalogue', {
    description: 'Import published products and opening bid prices only from the explicitly verified, connected WhatsApp Meta catalogue. Skips test products and unparseable prices; never guesses whether raw integer prices mean cents.',
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, () => run(() => auction.importFromVerifiedCatalogue()));

  server.registerTool('auction_preview_hourly_graphic', {
    description: 'Produce the current branded JPG auction graphic for review, including catalogue opening bids and highest confirmed bids. Preview only: does not send or publish to WhatsApp.',
    inputSchema: {}, annotations: read,
  }, async (): Promise<CallToolResult> => {
    try {
      const result = await auction.preview();
      return {
        content: [
          { type: 'image', data: result.image.toString('base64'), mimeType: 'image/jpeg' },
          { type: 'text', text: JSON.stringify({
            displayedLots: result.count, totalLots: result.total,
            note: 'Preview only. No Channel post has been published.',
          }) },
        ],
      };
    } catch (error) {
      return { ...answer({ error: error instanceof Error ? error.message : String(error) }), isError: true };
    }
  });

  server.registerTool('auction_publish_channel_graphic_now', {
    description: 'Publish one live branded auction digest to the configured WhatsApp Channel. This is a PUBLIC post; invoke only when the owner explicitly asks to send a live test or publish now. Requires a verified @newsletter Channel ID and enabled posting flags.',
    inputSchema: {}, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, () => run(() => auction.publishHour()));
}
