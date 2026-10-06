# Shyann WhatsApp customization — deployment pending

This draft adds group inspection, conservative candidate filtering, history search, exact campaign previews, owner-only approval and sequential sending. Existing raw send tools cannot bypass approval. Text steps can contain Instagram Reel URLs; image steps accept bounded PNG/JPEG data.

## Approval and privacy

HTTP requires OAuth, loopback binding and MCP_OWNER_SECRET (at least 32 random characters). Publish only through an authenticated HTTPS deployment after validating its cost and compatibility. Owner authentication protects OAuth consent, WhatsApp linking and campaign approval pages. Linking WhatsApp no longer automatically authorizes arbitrary OAuth clients. An owner must approve the exact client and redirect destination.

Campaign previews expose no approval secret. The owner reviews all recipients and steps in the protected browser page, approves once, then the execute tool can send that immutable draft for 15 minutes. Eligibility is checked again before sending. Never approve a batch until synchronized history coverage is acceptable.

Store campaign, OAuth and WhatsApp session data outside the repository on persistent disk with restrictive permissions. Set CAMPAIGN_STORE_PATH to that private journal path. Never commit session files or owner secrets. Keep one service process per journal. A crash can leave a .sending.lock file: stop the service and reconcile actual WhatsApp deliveries before an operator removes the stale lock. Never reset a sending/uncertain draft to approved or automatically retry it.

## Important limitations

Baileys currently reports contacts without an address-book name as saved-status UNKNOWN, not proven unsaved. Such contacts are excluded, so the desired unsaved-contact campaign can return no candidates in browserless mode. Do not weaken this filter to fill a quota. A verified contact-status source or a tested browser backend is still needed for that workflow. Chromium has not been approved or sized for this VM.

History search covers at most 1,000 synchronized messages per person and cannot prove someone was never contacted. Missing names and unresolved identities are excluded; unresolved identities in an exclusion group abort selection. Candidate scanning stops after 300 distinct members. No messages have been sent during development.

## Deployment gate

No VM or paid resource has been provisioned by this change. Inspect the existing Google Cloud project and actual VM/network configuration first. Reverify permanent Free Tier eligibility, account-wide allowance usage and egress. Do not enable paid IPv4, NAT, upgrades or paid tunnels without explicit approval. IPv6 reachability to every dependency and WhatsApp must be tested before selecting an IPv6-only deployment.

Use a supported Node.js release (target Node 24). The upstream optional Baileys dependencies are needed for browserless operation. PUPPETEER_SKIP_DOWNLOAD=true avoids a Chromium download during installation. Configure persistent service paths after reviewing upstream backend environment settings. Desktop Commander pairing and reboot persistence remain to be implemented on the real VM.

## Validation

Run `node --experimental-strip-types --test test/campaign-safety.test.mjs` for dependency-free approval, duplicate-send and filtering tests. Full TypeScript build, upstream Vitest tests, HTTP/OAuth integration, WhatsApp linking, actual contact data, tunnel authentication and reboot tests are still required before deployment. The first real outbound test requires explicit approval for one recipient and the exact message.
