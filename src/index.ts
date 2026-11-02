import { Room, type Env } from "./room";

export { Room };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const roomMatch = url.pathname.match(/^\/api\/room\/([A-Z2-9]{4})$/i);
    if (roomMatch) {
      const code = roomMatch[1].toUpperCase();
      const id = env.ROOM.idFromName(code);
      const stub = env.ROOM.get(id);
      const wsUrl = new URL(request.url);
      wsUrl.pathname = "/";
      return stub.fetch(new Request(wsUrl.toString(), request));
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
