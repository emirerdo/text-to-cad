import { cadApiUrl } from '@text-to-cad/core/client';
import type { AgentContextPort, AttachmentStore } from '@text-to-cad/ui/host';

const POLL_MS = 1500;
const TAB_KEY = 'cad.agent-context.tab';
const HEADERS = { 'content-type': 'application/json', 'x-cadgen-viewer': '1' };

function tabId(storage: Pick<Storage, 'getItem' | 'setItem'>): string {
  try {
    const held = storage.getItem(TAB_KEY);
    if (held) return held;
    const made = globalThis.crypto.randomUUID();
    storage.setItem(TAB_KEY, made);
    return made;
  } catch { return globalThis.crypto.randomUUID(); }
}

/**
 * This tab's selection, held by the viewer server until the person's agent reads it with their next
 * message (`cadgen/viewer/agent_context.py`). A tab that opens or closes takes its selection with
 * it, so nothing from a closed page rides along later. While a selection waits, the server is asked
 * whether it has gone; otherwise nothing is polled.
 */
export function createAgentContext({ origin, attachments, fetch: fetchImpl = globalThis.fetch.bind(globalThis), storage = globalThis.sessionStorage, target = globalThis as Pick<Window, 'addEventListener' | 'setTimeout' | 'clearTimeout'> }: {
  origin: string; attachments: AttachmentStore; fetch?: typeof globalThis.fetch; storage?: Pick<Storage, 'getItem' | 'setItem'>; target?: Pick<Window, 'addEventListener' | 'setTimeout' | 'clearTimeout'>;
}): AgentContextPort {
  const tab = tabId(storage);
  const url = cadApiUrl('/__cad/context', { origin });
  const send = (text: string, paths: readonly string[], init: RequestInit = {}) => fetchImpl(url, { method: 'POST', headers: HEADERS, body: JSON.stringify({ tab, text, paths }), ...init });
  const listeners = new Set<() => void>();
  let delivered = false, latest = 0, pictureKey = '', picturePath = '', timer = 0;

  const setDelivered = (next: boolean) => {
    if (next === delivered) return;
    delivered = next;
    for (const listener of listeners) listener();
  };
  const stopPolling = () => { target.clearTimeout(timer); timer = 0; };
  const poll = (run: number) => {
    timer = target.setTimeout(async () => {
      try {
        const response = await fetchImpl(cadApiUrl('/__cad/context', { origin, params: { tab } }));
        const status = await response.json() as { delivered?: boolean; revision?: number };
        if (run !== latest) return;
        if (status.delivered) { setDelivered(true); return; }
        if (status.revision) poll(run);
      } catch { if (run === latest) poll(run); }
    }, POLL_MS) as unknown as number;
  };

  // Whatever an earlier page of this tab left behind is gone with it.
  void send('', []).catch(() => {});
  target.addEventListener('pagehide', () => { void send('', [], { keepalive: true }).catch(() => {}); });

  return {
    publish({ text, paths, picture, pictureKey: key, pictureName }) {
      const run = ++latest;
      stopPolling();
      setDelivered(false);
      if (!text) { pictureKey = ''; picturePath = ''; void send('', []).catch(() => {}); return; }
      void (async () => {
        if (picture && key !== pictureKey) {
          const saved = await attachments.save(await picture(), pictureName);
          if (run !== latest) return;
          pictureKey = key;
          picturePath = saved;
        }
        if (!picture) { pictureKey = ''; picturePath = ''; }
        const message = picturePath ? `${text}\nImage (numbered pins match the list): ${picturePath}` : text;
        await send(message, paths);
        if (run === latest) poll(run);
      })().catch(() => {});
    },
    getDelivered: () => delivered,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
