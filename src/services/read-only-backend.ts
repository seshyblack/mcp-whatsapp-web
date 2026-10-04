import type { WhatsAppBackend } from './backend.js';

/** Existing read tools retain their implementation; raw sends cannot bypass campaign approval. */
export function readOnlyBackend(backend: WhatsAppBackend): WhatsAppBackend {
  const writes = new Set(['sendMessage', 'sendMedia', 'sendMediaFromBase64', 'sendVoiceNote']);
  return new Proxy(backend, {
    get(target, property) {
      if (writes.has(String(property))) return async () => { throw new Error('Direct sends are disabled. Create a campaign draft, obtain owner approval, then execute that exact draft.'); };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
