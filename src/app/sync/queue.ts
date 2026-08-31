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

export interface SyncQueue {
  push(record: SyncRecord): void;
  flush(): Promise<void>;
  onIncoming(handler: (record: SyncRecord) => void): void;
}

/** Wraps a WebSocket connection to the user's Durable Object (section 3.1). Reconnection
 * policy is deliberately simple here — exponential backoff and connection-state UI are a
 * shell-level concern once the first tile (notes) proves the loop end-to-end. */
export function createSyncQueue(socketUrl: string): SyncQueue {
  const pending: SyncRecord[] = [];
  const incomingHandlers: Array<(record: SyncRecord) => void> = [];
  let socket: WebSocket | null = null;

  function connect(): WebSocket {
    const ws = new WebSocket(socketUrl);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => void flush();
    ws.onmessage = (event) => {
      const record = decodeEnvelope(event.data as ArrayBuffer);
      for (const handler of incomingHandlers) handler(record);
    };
    ws.onclose = () => {
      socket = null;
      setTimeout(connect, 2000);
    };
    return ws;
  }

  async function flush(): Promise<void> {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    while (pending.length > 0) {
      const record = pending.shift()!;
      socket.send(encodeEnvelope(record));
    }
  }

  socket = connect();

  return {
    push(record: SyncRecord) {
      pending.push(record);
      void flush();
    },
    flush,
    onIncoming(handler) {
      incomingHandlers.push(handler);
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
