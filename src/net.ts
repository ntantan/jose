import {
  closeReason,
  type RoomSummary,
  type Say,
  type ClientMessage,
  type ServerMessage,
} from "../shared/protocol";

/** Head angles are sent at ~15/s; more than that is wasted bandwidth. */
const LOOK_INTERVAL_MS = 66;
/** Below this the movement isn't visible on a remote avatar. */
const LOOK_EPSILON = 0.002;

type Handlers = {
  [K in ServerMessage["t"]]?: (message: Extract<ServerMessage, { t: K }>) => void;
};

/** Typed WebSocket wrapper for one room session. */
export class RoomConnection {
  private readonly socket: WebSocket;
  private readonly handlers: Handlers = {};
  private onClosed?: (reason: string, wasExpected: boolean) => void;

  private lastSentAt = 0;
  private lastYaw = Number.NaN;
  private lastPitch = Number.NaN;
  /** Set when we close deliberately, so leaving isn't reported as an error. */
  private leaving = false;

  constructor(code: string, name: string) {
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const url = new URL(
      `${scheme}//${location.host}/api/rooms/${code}/ws`,
    );
    url.searchParams.set("name", name);

    this.socket = new WebSocket(url);
    this.socket.addEventListener("message", this.handleMessage);
    this.socket.addEventListener("close", this.handleClose);
  }

  on<K extends ServerMessage["t"]>(
    type: K,
    handler: (message: Extract<ServerMessage, { t: K }>) => void,
  ): void {
    this.handlers[type] = handler as Handlers[K];
  }

  onClose(handler: (reason: string, wasExpected: boolean) => void): void {
    this.onClosed = handler;
  }

  /** Throttled, and skipped entirely when the head hasn't moved. */
  sendLook(yaw: number, pitch: number): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;

    const now = performance.now();
    if (now - this.lastSentAt < LOOK_INTERVAL_MS) return;
    if (
      Math.abs(yaw - this.lastYaw) < LOOK_EPSILON &&
      Math.abs(pitch - this.lastPitch) < LOOK_EPSILON
    ) {
      return;
    }

    this.lastSentAt = now;
    this.lastYaw = yaw;
    this.lastPitch = pitch;
    this.send({ t: "look", yaw, pitch });
  }

  /** Say one of the fixed actions at another player. */
  sendSay(to: string, say: Say): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.send({ t: "say", to, ...say });
  }

  close(): void {
    this.leaving = true;
    this.socket.close(1000, "left");
  }

  private send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  private handleMessage = (event: MessageEvent): void => {
    let message: ServerMessage;
    try {
      message = JSON.parse(event.data as string) as ServerMessage;
    } catch {
      return;
    }
    const handler = this.handlers[message.t] as
      | ((m: ServerMessage) => void)
      | undefined;
    handler?.(message);
  };

  private handleClose = (event: CloseEvent): void => {
    this.onClosed?.(closeReason(event.code), this.leaving);
  };
}

/** The open rooms, for the lobby. */
export async function listRooms(): Promise<RoomSummary[]> {
  const response = await fetch("/api/rooms");
  if (!response.ok) throw new Error("Could not list rooms.");
  return (await response.json()) as RoomSummary[];
}

/** Your room's code: minted on the first call, the same one after that. */
export async function createRoom(): Promise<string> {
  const response = await fetch("/api/rooms", { method: "POST" });
  if (!response.ok) throw new Error("Could not create a room.");
  const body = (await response.json()) as { code: string };
  return body.code;
}
