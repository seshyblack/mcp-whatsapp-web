# WhatsApp Business catalogue upload (official Meta API)

The linked-device WhatsApp connection (Baileys/web.js) can send messages but **cannot modify the native WhatsApp Business app catalogue**. Catalogue tools here operate on a **Meta Commerce catalogue that is verified as linked to the specified WhatsApp Business Account (WABA)**. Do not use them to promise edits to an unrelated app-only catalogue.

## Required private environment (on the deployment, not in Git)

- `META_GRAPH_ACCESS_TOKEN`: a Meta system-user access token with access to the correct business catalogue and WABA; required permissions include `catalog_management` and `whatsapp_business_management`
- `WHATSAPP_CATALOG_ID`: exact Meta Commerce catalogue ID
- `WHATSAPP_BUSINESS_ACCOUNT_ID`: WABA ID for the **business number where items must appear**
- `META_GRAPH_VERSION`: optional supported Graph version (default v26.0)

Set these as secret variables on the existing deployment. Never provide the token in chat or commit it. A QR-linked WhatsApp session does not give the Graph API permissions.

## Owner workflow

1. Run `whatsapp_catalog_status` to verify the target catalogue is **linked=true** to the intended WABA.
2. Run `whatsapp_catalog_list_products` and compare existing retailer IDs to the proposed additions. Check images, URLs, prices, currency, product names and descriptions with the owner before modifying anything.
3. Run `whatsapp_catalog_upload_products` with `action=CREATE` or `UPDATE`, 1–25 explicitly approved products at a time. Create requires complete product fields.
4. Poll `whatsapp_catalog_batch_status` for the returned batch handle(s); check per-item errors and review/visibility in the WhatsApp Business account itself. Accepted API requests are **not** proof that products are visible in WhatsApp.

Do not change the WABA association or replace its connected catalogue automatically, because that may displace an existing app-based catalogue. The tools fail closed if access credentials or link verification are missing. Existing messaging tools are unchanged.

References: Meta Commerce Catalog Batch API (/{catalog_id}/items_batch and /check_batch_request_status); Meta WhatsApp Business Account /product_catalogs; WhatsApp Manager > Account tools > Catalogue.

## Deployment
Changes are isolated in a feature branch. Run `npm ci`, `npm run build`, `npm test` before merge. Deploy only after confirming the existing Render service/workspace and adding the private credentials. Refresh the ChatGPT WhatsApp connector after redeployment to make the new tools available.
