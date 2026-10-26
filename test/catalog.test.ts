import { describe, expect, it, vi } from 'vitest';
import { WhatsAppCatalog } from '../src/services/catalog.js';

const env = {
  META_GRAPH_ACCESS_TOKEN: 'private-test-token',
  WHATSAPP_CATALOG_ID: '925133185886341',
  WHATSAPP_BUSINESS_ACCOUNT_ID: '123456789',
  META_GRAPH_VERSION: 'v26.0',
};

const product = {
  retailer_id: 'CALM-CHAIR-01',
  name: 'Calmistry Chair',
  description: 'A premium accent chair',
  image_url: 'https://example.org/chair.jpg',
  url: 'https://example.org/chair',
  price: '129.00',
  currency: 'MYR',
  availability: 'in stock' as const,
  condition: 'new' as const,
  brand: 'Calmistry',
};

const ok = (data: unknown) => new Response(JSON.stringify(data), {
  status: 200, headers: { 'content-type': 'application/json' },
});

describe('WhatsApp-connected catalog safety', () => {
  it('does not trust WhatsApp linked-device credentials alone', async () => {
    const send = vi.fn();
    const api = new WhatsAppCatalog({}, send as unknown as typeof fetch);
    await expect(api.status()).rejects.toThrow(/not configured/);
    expect(send).not.toHaveBeenCalled();
  });

  it('requires a verified WABA-catalog match before uploading', async () => {
    const send = vi.fn(async () => ok({ data: [{ id: '9999999' }] }));
    const api = new WhatsAppCatalog(env, send as unknown as typeof fetch);
    await expect(api.submit('CREATE', [product])).rejects.toThrow(/Refusing to upload/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('uploads only after linking and disables implicit upserts', async () => {
    const send = vi.fn(async (url: string, req?: RequestInit) => {
      if (url.endsWith('/product_catalogs')) return ok({ data: [{ id: env.WHATSAPP_CATALOG_ID }] });
      const form = new URLSearchParams(String(req?.body));
      expect(form.get('item_type')).toBe('PRODUCT_ITEM');
      expect(form.get('allow_upsert')).toBe('false');
      const requests = JSON.parse(form.get('requests') || '[]');
      expect(requests).toMatchObject([{ method: 'CREATE', data: {
        id: product.retailer_id, title: product.name, price: '129.00 MYR',
      } }]);
      expect(req?.headers).toMatchObject({ Authorization: 'Bearer private-test-token' });
      return ok({ handles: ['batch-123'], validation_status: [] });
    });
    const api = new WhatsAppCatalog(env, send as unknown as typeof fetch);
    const result = await api.submit('CREATE', [product]);
    expect(result).toMatchObject({ submitted: true, visibleOnWhatsApp: false, handles: ['batch-123'] });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('rejects incomplete new products before calling batch endpoint', async () => {
    const send = vi.fn(async () => ok({ data: [{ id: env.WHATSAPP_CATALOG_ID }] }));
    const api = new WhatsAppCatalog(env, send as unknown as typeof fetch);
    await expect(api.submit('CREATE', [{ retailer_id: 'X', name: 'X' }])).rejects.toThrow(/need name/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicate retailer IDs', async () => {
    const send = vi.fn(async () => ok({ data: [{ id: env.WHATSAPP_CATALOG_ID }] }));
    const api = new WhatsAppCatalog(env, send as unknown as typeof fetch);
    await expect(api.submit('CREATE', [product, product])).rejects.toThrow(/distinct stable/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not return access tokens in API error output', async () => {
    const send = vi.fn(async () => new Response(JSON.stringify({ error: { code: 10, message: 'Missing catalogue permissions' } }), { status: 403 }));
    const api = new WhatsAppCatalog(env, send as unknown as typeof fetch);
    await expect(api.status()).rejects.toThrow(/Missing catalogue permissions/);
    await expect(api.status()).rejects.not.toThrow(/private-test-token/);
  });
});
