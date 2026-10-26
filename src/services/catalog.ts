/**
 * Official Meta Graph catalogue client for a WhatsApp Business Account (WABA).
 *
 * The Baileys/Web.js linked-device session cannot edit native app-only catalogues.
 * Only write to an existing Meta catalogue after verifying it is attached to the
 * configured WABA. Do not claim a submitted batch is visible in WhatsApp:
 * ingestion and WhatsApp item review are asynchronous.
 */
export type CatalogProduct = {
  retailer_id: string;
  name?: string;
  description?: string;
  image_url?: string;
  url?: string;
  price?: string;
  currency?: string;
  availability?: 'in stock' | 'out of stock' | 'preorder' | 'available for order' | 'discontinued';
  condition?: 'new' | 'used' | 'refurbished';
  brand?: string;
};

type GraphResponse = Record<string, unknown>;

export class WhatsAppCatalog {
  private readonly token: string;
  readonly catalogId: string;
  readonly wabaId: string;
  private readonly base: string;

  constructor(env: NodeJS.ProcessEnv = process.env, private readonly http: typeof fetch = fetch) {
    this.token = env.META_GRAPH_ACCESS_TOKEN || '';
    this.catalogId = env.WHATSAPP_CATALOG_ID || '';
    this.wabaId = env.WHATSAPP_BUSINESS_ACCOUNT_ID || '';
    const version = env.META_GRAPH_VERSION || 'v26.0';
    if (!/^v\d+\.0$/.test(version)) throw new Error('Invalid META_GRAPH_VERSION.');
    this.base = 'https://graph.facebook.com/' + version;
  }

  configured(): boolean {
    return Boolean(this.token && /^\d+$/.test(this.catalogId) && /^\d+$/.test(this.wabaId));
  }

  private requireConfiguration(): void {
    if (!this.configured()) {
      throw new Error(
        'WhatsApp catalogue not configured: set META_GRAPH_ACCESS_TOKEN, ' +
        'WHATSAPP_CATALOG_ID and WHATSAPP_BUSINESS_ACCOUNT_ID in private Render environment. ' +
        'The ordinary WhatsApp linked-device session does not grant catalogue access.',
      );
    }
  }

  private async request(path: string, options: RequestInit = {}): Promise<GraphResponse> {
    this.requireConfiguration();
    const result = await this.http(this.base + path, {
      ...options,
      headers: {
        Authorization: 'Bearer ' + this.token,
        ...options.headers,
      },
      signal: AbortSignal.timeout(20000),
    });
    let json: GraphResponse;
    try {
      json = (await result.json()) as GraphResponse;
    } catch {
      throw new Error('Meta Graph returned an invalid JSON response (HTTP ' + result.status + ').');
    }
    if (!result.ok || json.error) {
      const detail = json.error as { message?: string; code?: number } | undefined;
      // Never include the token or the request Authorization header in errors.
      throw new Error(
        'Meta Graph error (HTTP ' + result.status + ', code ' + (detail?.code || 'unknown') +
        '): ' + (detail?.message || 'Request rejected'),
      );
    }
    return json;
  }

  async status(): Promise<{ configured: boolean; linked: boolean; catalogId: string; wabaId: string; linkedCatalogIds: string[] }> {
    this.requireConfiguration();
    const response = await this.request('/' + this.wabaId + '/product_catalogs');
    const records = Array.isArray(response.data) ? response.data : [];
    const linkedCatalogIds = records.map((record: unknown) => {
      const item = record as { id?: unknown; catalog_id?: unknown; catalog?: { id?: unknown } };
      return String(item.catalog_id || item.catalog?.id || item.id || '');
    }).filter(Boolean);
    return {
      configured: true,
      linked: linkedCatalogIds.includes(this.catalogId),
      catalogId: this.catalogId,
      wabaId: this.wabaId,
      linkedCatalogIds,
    };
  }

  private async requireLinked(): Promise<void> {
    const status = await this.status();
    if (!status.linked) {
      throw new Error(
        'Refusing to upload: the selected Meta catalogue is not verified as connected to this WhatsApp Business Account. ' +
        'Connect the correct catalogue in WhatsApp Manager or the WhatsApp Business app first. ' +
        'Do not connect another catalogue automatically: doing so may hide the existing app catalogue.',
      );
    }
  }

  async listProducts(limit = 25): Promise<GraphResponse> {
    await this.requireLinked();
    const fields = encodeURIComponent('id,retailer_id,name,description,price,currency,image_url,availability');
    return this.request('/' + this.catalogId + '/products?fields=' + fields + '&limit=' + Math.min(limit, 100));
  }

  /**
   * Returns a submitted handle, NOT a claim that items are visible to customers.
   * CREATE never silently overwrites; UPDATE uses the stable retailer ID.
   */
  async submit(action: 'CREATE' | 'UPDATE', items: CatalogProduct[]): Promise<GraphResponse> {
    await this.requireLinked();
    if (!items.length || items.length > 25) throw new Error('Provide 1–25 products per batch.');
    const ids = new Set<string>();
    const requests = items.map(item => {
      if (!/^[A-Za-z0-9._:-]{1,100}$/.test(item.retailer_id) || ids.has(item.retailer_id)) {
        throw new Error('Each product must have a distinct stable retailer_id (1–100 alphanumeric / . _ : - characters).');
      }
      ids.add(item.retailer_id);
      if (action === 'CREATE' && (!item.name || !item.description || !item.image_url || !item.url ||
        !item.price || !item.currency || !item.availability || !item.condition || !item.brand)) {
        throw new Error('New products need name, description, image_url, url, price, currency, availability, condition and brand.');
      }
      if (item.currency && !/^[A-Z]{3}$/.test(item.currency)) throw new Error('Invalid ISO currency code.');
      if (item.price && !/^\d+(\.\d{1,2})?$/.test(item.price)) throw new Error('Enter price in major currency units, e.g. 129.00.');
      if (item.price && !item.currency) throw new Error('A price needs its currency.');
      for (const field of ['image_url', 'url'] as const) {
        if (item[field]) {
          const parsed = new URL(item[field]);
          if (parsed.protocol !== 'https:') throw new Error(field + ' must use HTTPS.');
        }
      }
      const data: Record<string, string> = { id: item.retailer_id };
      if (item.name !== undefined) data.title = item.name;
      if (item.description !== undefined) data.description = item.description;
      if (item.image_url !== undefined) data.image_link = item.image_url;
      if (item.url !== undefined) data.link = item.url;
      if (item.price !== undefined) data.price = item.price + ' ' + item.currency;
      if (item.availability !== undefined) data.availability = item.availability;
      if (item.condition !== undefined) data.condition = item.condition;
      if (item.brand !== undefined) data.brand = item.brand;
      if (action === 'UPDATE' && Object.keys(data).length === 1) {
        throw new Error('UPDATE requires at least one changed field.');
      }
      return { method: action, data };
    });
    const form = new URLSearchParams();
    form.set('item_type', 'PRODUCT_ITEM');
    // The Batch API defaults to upsert; never overwrite/create the opposite action silently.
    form.set('allow_upsert', 'false');
    form.set('requests', JSON.stringify(requests));
    const response = await this.request('/' + this.catalogId + '/items_batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    return { submitted: true, visibleOnWhatsApp: false, note: 'Meta processes the batch asynchronously. Check the returned handles and WhatsApp approval before claiming publication.', ...response };
  }

  async batchStatus(handle: string): Promise<GraphResponse> {
    if (!/^[A-Za-z0-9_-]{1,300}$/.test(handle)) throw new Error('Invalid batch handle.');
    await this.requireLinked();
    return this.request('/' + this.catalogId + '/check_batch_request_status?handle=' + encodeURIComponent(handle));
  }
}
