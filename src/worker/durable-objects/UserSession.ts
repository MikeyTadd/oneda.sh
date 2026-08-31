// One Durable Object instance per user (section 3.1). Pure relay + coordination —
// this class never decrypts anything and must never gain a code path that does.

export class UserSession implements DurableObject {
  private state: DurableObjectState;
  private env: unknown;
  private sockets: Set<WebSocket> = new Set();

  constructor(state: DurableObjectState, env: unknown) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/ws")) {
      return this.handleWebSocketUpgrade(request);
    }

    return new Response("not found", { status: 404 });
  }

  private handleWebSocketUpgrade(request: Request): Response {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.state.acceptWebSocket(server);
    this.sockets.add(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  // Durable Object WebSocket hibernation API handlers (state.acceptWebSocket above).
  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    // Every inbound message is an opaque ciphertext envelope: { dataNamespace, seq, ciphertext }.
    // The DO's only job is to persist it (D1/R2, via env bindings — wired in index.ts once the
    // sync-queue wire format is finalized) and broadcast it to this user's other connected
    // devices. It must never branch on decrypted content, because it can't decrypt anything.
    this.broadcast(ws, message);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.sockets.delete(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.sockets.delete(ws);
  }

  /** Alarm handler for reminders (section 6.1) — set via state.storage.setAlarm() when a
   * reminder is created. Fires the silent-push-then-fetch pattern (section 6) rather than
   * reading any decrypted reminder content, which this DO never has access to. */
  async alarm(): Promise<void> {
    // TODO: look up any reminders due now for this user, trigger Web Push (section 6.1).
  }

  private broadcast(origin: WebSocket, message: ArrayBuffer | string): void {
    for (const socket of this.sockets) {
      if (socket === origin) continue;
      try {
        socket.send(message);
      } catch {
        this.sockets.delete(socket);
      }
    }
  }
}
