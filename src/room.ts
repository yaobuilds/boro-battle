import questionData from "../questions.json";
import {
  applyAlarm,
  applyAnswer,
  applyDisconnect,
  applyJoin,
  applyReady,
  applyRematch,
  applyStart,
  buildStatePayload,
  classifyJoin,
  consumeRateLimit,
  emptyRoomState,
  isOversizedMessage,
  missingRoom,
  parseClientMessage,
  type Question,
  type RoomState,
} from "./game";

export interface Env {
  ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
}

interface SocketAttachment {
  playerId?: string;
  rateLimitTimestamps?: number[];
}

export class Room implements DurableObject {
  private state: RoomState = emptyRoomState();
  private questionPool: Question[] = questionData as Question[];
  private initialized = false;
  private savedRoom = false;

  constructor(
    private ctx: DurableObjectState,
    private env: Env,
  ) {}

  private async ensureInit(): Promise<void> {
    if (this.initialized) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS room_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          json TEXT NOT NULL
        );
      `);
      const rows = [
        ...this.ctx.storage.sql.exec<{ json: string }>(
          `SELECT json FROM room_state WHERE id = 1`,
        ),
      ];
      if (rows.length > 0) {
        this.state = JSON.parse(rows[0].json) as RoomState;
        this.savedRoom = true;
      }
      this.initialized = true;
    });
  }

  private async persist(): Promise<void> {
    const json = JSON.stringify(this.state);
    this.ctx.storage.sql.exec(
      `INSERT INTO room_state (id, json) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
      json,
    );
  }

  private scheduleAlarm(deadlineMs: number | null): void {
    if (deadlineMs === null) {
      void this.ctx.storage.deleteAlarm();
      return;
    }
    void this.ctx.storage.setAlarm(deadlineMs);
  }

  private syncAlarm(): void {
    this.scheduleAlarm(this.state.deadlineMs);
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureInit();

    const upgrade = request.headers.get("Upgrade");
    if (upgrade !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const url = new URL(request.url);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    await this.ensureInit();

    const byteLength =
      typeof message === "string"
        ? new TextEncoder().encode(message).length
        : message.byteLength;
    if (isOversizedMessage(byteLength)) return;
    if (typeof message !== "string") return;

    const nowMs = Date.now();
    let attachment = ws.deserializeAttachment() as SocketAttachment | null;
    const rate = consumeRateLimit(attachment?.rateLimitTimestamps ?? [], nowMs);
    ws.serializeAttachment({
      playerId: attachment?.playerId,
      rateLimitTimestamps: rate.timestamps,
    });
    if (!rate.allowed) return;

    const parsed = parseClientMessage(message);
    if (!parsed) return;

    attachment = ws.deserializeAttachment() as SocketAttachment | null;

    switch (parsed.type) {
      case "join": {
        if (missingRoom(this.savedRoom, parsed.create)) {
          try {
            ws.send(JSON.stringify({ type: "error", code: "not_found" }));
            ws.close();
          } catch {
            // socket may already be closing
          }
          break;
        }
        // A refresh or a flaky connection can leave the old socket open. The id is a
        // private random value, so the newest connection takes over the seat.
        for (const other of this.ctx.getWebSockets()) {
          if (other === ws) continue;
          const att = other.deserializeAttachment() as SocketAttachment | null;
          if (att?.playerId !== parsed.playerId) continue;
          // Clear the id first so closing it does not mark the player disconnected.
          other.serializeAttachment({});
          try {
            other.close(1000, "replaced");
          } catch {
            // socket may already be closing
          }
        }
        const joinKind = classifyJoin(this.state, {
          playerId: parsed.playerId,
          name: parsed.name,
        });
        if (joinKind === "bad_name") break;
        if (joinKind === "full") {
          try {
            ws.send(JSON.stringify({ type: "error", code: "room_full" }));
            ws.close();
          } catch {
            // socket may already be closing
          }
          break;
        }
        this.state = applyJoin(this.state, {
          playerId: parsed.playerId,
          name: parsed.name,
        });
        ws.serializeAttachment({
          playerId: parsed.playerId,
          rateLimitTimestamps: attachment?.rateLimitTimestamps ?? rate.timestamps,
        });
        await this.persist();
        this.savedRoom = true;
        await this.broadcast();
        break;
      }
      case "ready": {
        if (!attachment?.playerId) return;
        this.state = applyReady(this.state, attachment.playerId);
        await this.persist();
        await this.broadcast();
        break;
      }
      case "start": {
        if (!attachment?.playerId) return;
        const prevPhase = this.state.phase;
        this.state = applyStart(this.state, {
          playerId: attachment.playerId,
          deck: this.questionPool,
          nowMs,
        });
        if (this.state.phase !== prevPhase) {
          this.syncAlarm();
          await this.persist();
          await this.broadcast();
        }
        break;
      }
      case "answer": {
        if (!attachment?.playerId) return;
        this.state = applyAnswer(this.state, {
          playerId: attachment.playerId,
          choiceId: parsed.choiceId,
          nowMs,
        });
        await this.persist();
        await this.broadcast();
        break;
      }
      case "rematch": {
        if (!attachment?.playerId) return;
        this.state = applyRematch(this.state, {
          playerId: attachment.playerId,
        });
        this.syncAlarm();
        await this.persist();
        await this.broadcast();
        break;
      }
    }
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    await this.handleDisconnect(ws);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    await this.handleDisconnect(ws);
  }

  private async handleDisconnect(ws: WebSocket): Promise<void> {
    await this.ensureInit();
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (!attachment?.playerId) return;

    this.state = applyDisconnect(this.state, attachment.playerId);
    this.syncAlarm();
    await this.persist();
    await this.broadcast();
  }

  async alarm(): Promise<void> {
    await this.ensureInit();
    const nowMs = Date.now();
    this.state = applyAlarm(this.state, nowMs);
    this.syncAlarm();
    await this.persist();
    await this.broadcast();
  }

  private async broadcast(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      const attachment = ws.deserializeAttachment() as SocketAttachment | null;
      const payload = buildStatePayload(
        this.state,
        attachment?.playerId ?? null,
      );
      try {
        ws.send(JSON.stringify(payload));
      } catch {
        // socket may be closing
      }
    }
  }
}
