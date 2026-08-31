// One Durable Object instance per user (section 3.1). Pure relay + coordination —
// this class never decrypts anything and must never gain a code path that does.

export interface Env {
  DB: D1Database;
}

export class UserSession implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  // Cached once loaded, but never trusted as the only copy: a hibernation wake reconstructs
  // this class fresh and calls webSocketMessage directly with no upgrade request to read it
  // from again, so the durable copy in state.storage is the real source of truth.
  private userId: string | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/ws")) {
      return this.handleWebSocketUpgrade(request, url);
    }

    return new Response("not found", { status: 404 });
  }

  private async handleWebSocketUpgrade(request: Request, url: URL): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    // Set once by index.ts's handleSyncUpgrade (which already validated the session), from
    // the same string this DO's own id was derived from (idFromName) — this instance can't
    // ask "whose session am I" any other way, and persist() below needs a user_id to write.
    const userId = url.searchParams.get("userId");
    if (!userId) return new Response("missing userId", { status: 400 });
    await this.state.storage.put("userId", userId);
    this.userId = userId;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.state.acceptWebSocket(server);

    // The client's keep-alive (../../app/sync/queue.ts). Answered by the runtime
    // itself rather than by webSocketMessage, so a heartbeat never wakes this
    // object from hibernation — a ping that billed for a wake-up every 25
    // seconds per device would cost more than the dead sockets it detects.
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));

    return new Response(null, { status: 101, webSocket: client });
  }

  // Durable Object WebSocket hibernation API handlers (state.acceptWebSocket above).
  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    // Text frames are the keep-alive's business, and the runtime already answered
    // it above without waking this object — anything text that still reaches here
    // is not a record and must not be broadcast as one.
    if (typeof message === "string") return;

    this.broadcast(ws, message);
    try {
      await this.persist(message);
    } catch (err) {
      // A durability failure shouldn't also break the live relay the other devices are
      // already depending on — the write above already reached them regardless.
      console.error("tile_records persist failed", err);
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    // state.getWebSockets() (broadcast, below) already reflects a closed socket dropping
    // out on its own — nothing here needs to track membership by hand.
    void ws;
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    void ws;
  }

  /** Alarm handler for reminders (section 6.1) — set via state.storage.setAlarm() when a
   * reminder is created. Fires the silent-push-then-fetch pattern (section 6) rather than
   * reading any decrypted reminder content, which this DO never has access to. */
  async alarm(): Promise<void> {
    // TODO: look up any reminders due now for this user, trigger Web Push (section 6.1).
  }

  /** Every other live socket for this user. Read fresh via the hibernation API each time
   * rather than kept in an instance field — a Set populated only by handleWebSocketUpgrade
   * calls would be missing sockets attached in a DO lifetime before the most recent
   * hibernation, since the class is reconstructed from scratch on every wake. */
  private broadcast(origin: WebSocket, message: ArrayBuffer | string): void {
    for (const socket of this.state.getWebSockets()) {
      if (socket === origin) continue;
      try {
        socket.send(message);
      } catch {
        // A genuinely dead socket surfaces through webSocketClose/Error on its own; one bad
        // send here shouldn't stop the rest of this broadcast.
      }
    }
  }

  /** Decodes the same envelope src/app/sync/queue.ts encodes and durably persists it into
   * `tile_records` (section 3.2) — the piece that was still a TODO here. Without this, sync
   * only ever relayed a *live* change to whoever else happened to be connected at that exact
   * moment; a fresh device, or one whose local storage was cleared, had no way to ever see
   * data written before it connected. This DO still never decrypts anything: the record's iv
   * and ciphertext travel together as one opaque blob, framed the same way a wrapped_dek
   * column already is, and split back apart client-side (sync/hydrate.ts). */
  private async persist(message: ArrayBuffer): Promise<void> {
    const userId = this.userId ?? (await this.state.storage.get<string>("userId")) ?? null;
    if (!userId) return;

    const record = decodeEnvelope(message);
    const id = `${record.dataNamespace}:${record.recordId}`;
    const seq = await this.nextSeq();

    await this.env.DB.prepare(
      `INSERT INTO tile_records (id, user_id, data_namespace, ciphertext, seq, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET ciphertext = excluded.ciphertext, seq = excluded.seq, updated_at = excluded.updated_at`
    )
      .bind(id, userId, record.dataNamespace, record.wrapped, seq, record.updatedAt)
      .run();
  }

  /** A per-user counter kept in this DO's own durable storage, not a `MAX(seq)+1` read against
   * D1 — a Durable Object only ever processes one request at a time, so this is atomic for
   * free where a read-then-write against D1 from multiple callers wouldn't be. */
  private async nextSeq(): Promise<number> {
    const current = (await this.state.storage.get<number>("nextSeq")) ?? 0;
    const next = current + 1;
    await this.state.storage.put("nextSeq", next);
    return next;
  }
}

/** Mirrors sync/queue.ts's encodeEnvelope exactly (header length, then JSON header, then
 * ciphertext) but returns iv and ciphertext already concatenated — `tile_records.ciphertext`
 * stores that single opaque blob, the same iv[12]||ciphertext framing wrapped_dek columns
 * already use, rather than adding a schema column this DO would be the only reader of. */
function decodeEnvelope(buffer: ArrayBuffer): {
  dataNamespace: string;
  recordId: string;
  updatedAt: number;
  wrapped: ArrayBuffer;
} {
  const view = new DataView(buffer);
  const headerLen = view.getUint32(0, true);
  const headerBytes = new Uint8Array(buffer, 4, headerLen);
  const header = JSON.parse(new TextDecoder().decode(headerBytes)) as {
    dataNamespace: string;
    recordId: string;
    iv: number[];
    updatedAt: number;
  };
  const iv = new Uint8Array(header.iv);
  const ciphertext = new Uint8Array(buffer.slice(4 + headerLen));
  const wrapped = new Uint8Array(iv.length + ciphertext.length);
  wrapped.set(iv, 0);
  wrapped.set(ciphertext, iv.length);
  return { dataNamespace: header.dataNamespace, recordId: header.recordId, updatedAt: header.updatedAt, wrapped: wrapped.buffer };
}
