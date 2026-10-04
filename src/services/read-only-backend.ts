import type { WhatsAppBackend } from './backend.js';

/** Existing read tools retain their implementation; raw sends can only target the linked account itself. */
export function readOnlyBackend(backend: WhatsAppBackend): WhatsAppBackend {
  const writes = new Set(['sendMessage', 'sendMedia', 'sendMediaFromBase64', 'sendVoiceNote']);
  return new Proxy(backend, {
    get(target, property) {
      if (writes.has(String(property))) {
        return async (...args: unknown[]) => {
          const recipient = String(args[0] ?? '');
          const contact = recipient ? await target.getContactById(recipient) : null;
          if (!contact?.isMe) {
            throw new Error('Direct sends are disabled except to the linked WhatsApp account itself. Create a campaign draft, obtain owner approval, then execute that exact draft.');
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.apply(target, args) : value;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
