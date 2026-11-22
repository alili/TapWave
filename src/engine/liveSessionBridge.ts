import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { isTauriRuntime } from './tauriBridge';
import { LiveSidecarEvent } from '../types/liveSession';

export interface LiveTransportHandle {
  outputDir: string;
  send: (cmds: Array<Record<string, unknown>>) => void;
  stop: () => Promise<void>;
  dispose: () => void;
}

function parseEventLine(line: string): LiveSidecarEvent | null {
  try {
    const obj = JSON.parse(line) as LiveSidecarEvent;
    if (obj && typeof obj.type === 'string') return obj;
  } catch {
    // ignore malformed lines
  }
  return null;
}

export async function startLiveSessionTransport(
  startPayload: Record<string, unknown>,
  onEvent: (ev: LiveSidecarEvent) => void
): Promise<LiveTransportHandle> {
  const sessionId = String(startPayload.sessionId ?? `live_${Date.now()}`);

  if (isTauriRuntime()) {
    const unlisten: UnlistenFn = await listen<{ sessionId: string; line: string }>(
      'live-session-event',
      (event) => {
        if (event.payload?.sessionId !== sessionId) return;
        const parsed = parseEventLine(event.payload.line);
        if (parsed) onEvent(parsed);
      }
    );

    let outputDir = '';
    try {
      outputDir = await invoke<string>('live_session_start', {
        startJson: JSON.stringify(startPayload),
      });
    } catch (err) {
      unlisten();
      throw err;
    }

    let sendChain = Promise.resolve();
    let disposed = false;

    return {
      outputDir,
      send(cmds) {
        if (disposed || cmds.length === 0) return;
        const lines = cmds.map((c) => JSON.stringify(c)).join('\n');
        sendChain = sendChain
          .then(() => invoke<void>('live_session_send', { sessionId, lines }))
          .catch(() => {
            // ignore send failures after stop
          });
      },
      async stop() {
        await sendChain;
        await invoke<void>('live_session_stop', { sessionId });
      },
      dispose() {
        disposed = true;
        unlisten();
      },
    };
  }

  // Browser dev mode (vite.config.ts /api/live/*)
  const startResp = await fetch('/api/live/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(startPayload),
  });
  if (!startResp.ok) {
    throw new Error(`启动录制会话失败 (${startResp.status})`);
  }
  const { outputDir } = (await startResp.json()) as { sessionId: string; outputDir: string };

  const es = new EventSource(`/api/live/events?sid=${encodeURIComponent(sessionId)}`);
  es.onmessage = (msg) => {
    const parsed = parseEventLine(msg.data);
    if (parsed) onEvent(parsed);
  };

  let pendingLines: string[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const flushBatch = async () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pendingLines.length === 0) return;
    const body = pendingLines.join('\n');
    pendingLines = [];
    try {
      await fetch(`/api/live/send?sid=${encodeURIComponent(sessionId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body,
      });
    } catch {
      // ignore
    }
  };

  return {
    outputDir,
    send(cmds) {
      if (disposed || cmds.length === 0) return;
      for (const c of cmds) {
        pendingLines.push(JSON.stringify(c));
      }
      if (flushTimer === null) {
        flushTimer = setTimeout(() => {
          void flushBatch();
        }, 200);
      }
    },
    async stop() {
      await flushBatch();
      await fetch(`/api/live/stop?sid=${encodeURIComponent(sessionId)}`, { method: 'POST' });
    },
    dispose() {
      disposed = true;
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      es.close();
    },
  };
}
