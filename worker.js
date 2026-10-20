import { DurableObject } from "cloudflare:workers";

const roomPattern = /^[A-Z2-9]{12}$/;

export class PairingRoom extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.ctx = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    if (role !== "ipad" && role !== "pc") return new Response("Invalid role", { status: 400 });
    const currentSockets = this.ctx.getWebSockets();
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({ role });
    this.ctx.acceptWebSocket(server);
    for (const socket of currentSockets) {
      if (socket === server || socket.readyState !== WebSocket.OPEN) continue;
      try {
        if (socket.deserializeAttachment()?.role === role) {
          socket.close(1012, "Replaced by a reconnected app");
          continue;
        }
        socket.send(JSON.stringify({ type: "peer-ready" }));
        server.send(JSON.stringify({ type: "peer-ready" }));
      } catch {}
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(sender, raw) {
    if (typeof raw !== "string" || raw.length > 48_000) return;
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!new Set(["offer", "answer", "candidate"]).has(message.type)) return;
    const payload = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === sender || socket.readyState !== WebSocket.OPEN) continue;
      try {
        socket.send(payload);
      } catch {}
    }
  }

  webSocketClose() {}
  webSocketError() {}
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/signal/")) {
      const room = decodeURIComponent(url.pathname.slice("/signal/".length));
      if (!roomPattern.test(room)) return new Response("Invalid pairing code", { status: 400 });
      const id = env.PAIRING_ROOMS.idFromName(room);
      return env.PAIRING_ROOMS.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};
