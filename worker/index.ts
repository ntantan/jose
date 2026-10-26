import { Directory, directory } from "./directory";
import { Room } from "./room";
import { isValidCode } from "../shared/protocol";

export { Directory, Room };

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  DIRECTORY: DurableObjectNamespace<Directory>;
  ASSETS: Fetcher;
}

const WS_PATH = /^\/api\/rooms\/([^/]+)\/ws$/;

/**
 * Who a room belongs to, for the one-room-each rule. There are no accounts, so
 * it is the client address -- and for IPv6 its /64, since a single host can
 * pick any address in its prefix. Players behind one NAT share a room, which
 * for a party game in one house is what they want anyway.
 */
function ownerKey(request: Request): string {
  const ip = request.headers.get("CF-Connecting-IP") ?? "local";
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = [
    ...left,
    ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"),
    ...right,
  ];
  return `${groups.slice(0, 4).join(":")}::/64`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/rooms") {
      if (request.method === "POST") {
        const code = await directory(env).claim(ownerKey(request));
        return Response.json({ code });
      }
      if (request.method === "GET") {
        return Response.json(await directory(env).list());
      }
      return new Response("Method not allowed", { status: 405 });
    }

    const match = WS_PATH.exec(url.pathname);
    if (match) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected Upgrade: websocket", { status: 426 });
      }
      const code = match[1]!.toUpperCase();
      if (!isValidCode(code)) {
        return new Response("Malformed room code", { status: 400 });
      }
      return env.ROOM.getByName(code).fetch(request);
    }

    if (url.pathname.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
