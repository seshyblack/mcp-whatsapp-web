import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { WhatsAppCatalog } from '../services/catalog.js';

const product = z.object({
  retailer_id: z.string().min(1).max(100),
  name: z.string().max(200).optional(),
  description: z.string().max(5000).optional(),
  image_url: z.string().url().optional(),
  url: z.string().url().optional(),
  price: z.string().optional(),
  currency: z.string().optional(),
  availability: z.enum(['in stock', 'out of stock', 'preorder', 'available for order', 'discontinued']).optional(),
  condition: z.enum(['new', 'used', 'refurbished']).optional(),
  brand: z.string().max(200).optional(),
});
const readAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const result = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const run = async (fn: () => Promise<unknown>): Promise<CallToolResult> => {
  try { return result(await fn()); }
  catch (error) {
    return { ...result({ error: error instanceof Error ? error.message : String(error) }), isError: true };
  }
};

/** Catalogue edits use official Graph API rather than the linked-device messaging session. */
export function registerCatalogTools(server: McpServer, catalog = new WhatsAppCatalog()): void {
  server.registerTool('whatsapp_catalog_status', {
    description: 'Check whether a Meta product catalogue is explicitly linked to this WhatsApp Business Account. Never assume Meta catalogue items are visible on WhatsApp.',
    inputSchema: {},
    annotations: readAnnotations,
  }, () => run(() => catalog.status()));

  server.registerTool('whatsapp_catalog_list_products', {
    description: 'Read items in the verified WhatsApp-linked product catalogue. Does not guarantee WhatsApp customer visibility.',
    inputSchema: { limit: z.number().int().min(1).max(100).default(25) },
    annotations: readAnnotations,
  }, ({ limit }) => run(() => catalog.listProducts(limit)));

  server.registerTool('whatsapp_catalog_upload_products', {
    description: 'CREATE or UPDATE up to 25 products in an existing catalogue ONLY after verifying it is linked to the WhatsApp Business Account. Never infer user approval or claim WhatsApp publication from an accepted batch. Ask the owner to approve exact product names, prices and photos first.',
    inputSchema: { action: z.enum(['CREATE', 'UPDATE']), items: z.array(product).min(1).max(25) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, ({ action, items }) => run(() => catalog.submit(action, items)));

  server.registerTool('whatsapp_catalog_batch_status', {
    description: 'Check asynchronous Meta product ingestion using a returned batch handle. Successful ingestion does not itself confirm WhatsApp customer visibility.',
    inputSchema: { handle: z.string().min(1).max(300) },
    annotations: readAnnotations,
  }, ({ handle }) => run(() => catalog.batchStatus(handle)));
}
