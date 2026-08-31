// Sync queue (section 5.2). Local writes append here immediately so the app works fully
// offline; on reconnect the queue flushes over the DO's WebSocket. Pairs with the
// EncryptedStorage wrapper (storage/db.ts) — the queue only ever carries ciphertext + the
// non-sensitive metadata the DO needs to route/persist it (namespace, timestamp, seq).

export interface SyncRecord {
  dataNamespace: string;
  recordId: string;
  ciphertext: ArrayBuffer;
  iv: Uint8Array;
  updatedAt: number;
  /** Present once a tile's CRDT layer (Yjs, section 5.3) is wired in; simple append-only
   * tiles can omit this and rely on server-assigned ordering instead. */
  vectorClock?: Record<string, number>;
}

/** What the shell's connection chip reports. "connecting" covers both the first
 * attempt and every reconnect — from the reader's side they're the same fact. */
export type SyncStatus = "connecting" | "online" | "offline";

export interface SyncQueue {
  push(record: SyncRecord): void;
  flush(): Promise<void>;
  onIncoming(handler: (record: SyncRecord) => void): void;
  /** Called on every change, and once immediately with the current value. */
  onStatus(handler: (status: SyncStatus) => void): void;
}

/** Wraps a WebSocket connection to the user's Durable Object (section 3.1). Reconnection
 * policy is deliberately simple here — exponential backoff and connection-state UI are a
 * shell-level concern once the first tile (notes) proves the loop end-to-end. */
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 30000;

// A TCP socket can stay open long after it stops carrying anything — a dropped
// mobile connection, a NAT or proxy that quietly forgot about it. Neither end
// gets a close, so the app sits there believing it is synced. The only way to
// know is to ask and require an answer.
const PING_TEXT = "ping";
const PONG_TEXT = "pong";
const PING_EVERY_MS = 25000;
// Generous: this decides a live connection is dead, and a slow phone on a bad
// train line is not the same thing as a broken socket.
const PONG_TIMEOUT_MS = 10000;

export function createSyncQueue(socketUrl: string): SyncQueue {
  const pending: SyncRecord[] = [];
  const incomingHandlers: Array<(record: SyncRecord) => void> = [];
  const statusHandlers: Array<(status: SyncStatus) => void> = [];
  let socket: WebSocket | null = null;
  let status: SyncStatus = "connecting";
  let retryMs = RETRY_MIN_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let pongTimer: ReturnType<typeof setTimeout> | null = null;

  function setStatus(next: SyncStatus): void {
    if (next === status) return;
    status = next;
    for (const handler of statusHandlers) handler(next);
  }

  /** Offline is a fact the browser already knows; no point dialling to find out. */
  function idleStatus(): SyncStatus {
    return navigator.onLine ? "connecting" : "offline";
  }

  function connect(): void {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    setStatus(idleStatus());

    const ws = new WebSocket(socketUrl);
    ws.binaryType = "arraybuffer";
    // Assigned before any handler can fire. The previous version returned the
    // socket for the caller to assign, which the reconnect path never did — so
    // after a single drop `socket` stayed null and flush() returned early for
    // the rest of the session, silently.
    socket = ws;

    ws.onopen = () => {
      retryMs = RETRY_MIN_MS;
      setStatus("online");
      startHeartbeat();
      void flush();
    };
    ws.onmessage = (event) => {
      // Records are binary envelopes; the heartbeat is text, so the two can't be
      // confused for one another.
      if (typeof event.data === "string") {
        if (event.data === PONG_TEXT) clearPongTimer();
        return;
      }
      const record = decodeEnvelope(event.data as ArrayBuffer);
      for (const handler of incomingHandlers) handler(record);
    };
    ws.onclose = () => {
      // A socket that was already replaced isn't this one's business to clear.
      if (socket === ws) socket = null;
      stopHeartbeat();
      setStatus(idleStatus());
      scheduleReconnect();
    };
    // onerror is always followed by onclose, which owns the retry.
    ws.onerror = () => {};
  }

  function clearPongTimer(): void {
    if (pongTimer === null) return;
    clearTimeout(pongTimer);
    pongTimer = null;
  }

  function stopHeartbeat(): void {
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    clearPongTimer();
  }

  /** Only beats while the app is actually in front of someone. A backgrounded
   * PWA has its timers throttled to the point where a missed pong would say more
   * about iOS than about the connection, and waking the radio to prove a socket
   * nobody is watching is exactly the battery cost not to pay. Coming back to the
   * foreground pings immediately, which is when the answer actually matters. */
  function startHeartbeat(): void {
    stopHeartbeat();
    pingTimer = setInterval(ping, PING_EVERY_MS);
  }

  function ping(): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (document.visibilityState !== "visible") return;
    // Already waiting on one; a second would only reset the deadline it is meant
    // to enforce.
    if (pongTimer !== null) return;

    socket.send(PING_TEXT);
    pongTimer = setTimeout(() => {
      pongTimer = null;
      // Unanswered. Close rather than judge it directly: onclose is the one path
      // that resets state and reconnects, so the dead socket takes the same route
      // as any other.
      socket?.close();
    }, PONG_TIMEOUT_MS);
  }

  /** Backing off matters more here than in a tab: a phone with no signal would
   * otherwise wake the radio every two seconds for as long as the app is open. */
  function scheduleReconnect(): void {
    if (retryTimer !== null) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  }

  async function flush(): Promise<void> {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    while (pending.length > 0) {
      const record = pending.shift()!;
      socket.send(encodeEnvelope(record));
    }
  }

  connect();

  // The browser knows about the radio before a socket timeout would. Coming back
  // online retries at once rather than waiting out whatever backoff had built up.
  addEventListener("online", () => {
    retryMs = RETRY_MIN_MS;
    if (!socket) connect();
  });
  addEventListener("offline", () => setStatus("offline"));

  // Returning to the app is exactly when "is this still connected?" needs an
  // answer, and exactly when the socket is most likely to have died unnoticed
  // while the timers were throttled.
  addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (socket && socket.readyState === WebSocket.OPEN) ping();
    else if (!socket) {
      retryMs = RETRY_MIN_MS;
      connect();
    }
  });

  return {
    push(record: SyncRecord) {
      pending.push(record);
      void flush();
    },
    flush,
    onIncoming(handler) {
      incomingHandlers.push(handler);
    },
    onStatus(handler) {
      statusHandlers.push(handler);
      handler(status);
    },
  };
}

function encodeEnvelope(record: SyncRecord): ArrayBuffer {
  const header = new TextEncoder().encode(
    JSON.stringify({
      dataNamespace: record.dataNamespace,
      recordId: record.recordId,
      iv: Array.from(record.iv),
      updatedAt: record.updatedAt,
      vectorClock: record.vectorClock,
    })
  );
  const headerLen = new Uint32Array([header.byteLength]);
  const body = new Uint8Array(record.ciphertext);
  const out = new Uint8Array(4 + header.byteLength + body.byteLength);
  out.set(new Uint8Array(headerLen.buffer), 0);
  out.set(header, 4);
  out.set(body, 4 + header.byteLength);
  return out.buffer;
}

function decodeEnvelope(buffer: ArrayBuffer): SyncRecord {
  const view = new DataView(buffer);
  const headerLen = view.getUint32(0, true);
  const headerBytes = new Uint8Array(buffer, 4, headerLen);
  const header = JSON.parse(new TextDecoder().decode(headerBytes));
  const ciphertext = buffer.slice(4 + headerLen);
  return {
    dataNamespace: header.dataNamespace,
    recordId: header.recordId,
    iv: new Uint8Array(header.iv),
    updatedAt: header.updatedAt,
    vectorClock: header.vectorClock,
    ciphertext,
  };
}
