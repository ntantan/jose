import { DurableObject } from "cloudflare:workers";
import {
  CloseCode,
  isActionId,
  isSlurp,
  isTotemAction,
  LOSS_PAUSE_MS,
  MAX_PITCH,
  MAX_SEATS,
  sanitizeName,
  seatColor,
  type ActionId,
  type ClientMessage,
  type Player,
  type Say,
  type ServerMessage,
  type SlurpAction,
} from "../shared/protocol";
import { directory } from "./directory";
import type { Env } from "./index";

/** How long a room with nobody in it lingers (e.g. across a reload) before it is deleted. */
const EMPTY_ROOM_MS = 60_000;

/**
 * Per-socket message budget, as a token bucket: a steady rate plus a burst.
 * The client sends look updates at ~15/s and says at clicking speed.
 */
const MESSAGE_RATE = 30;
const MESSAGE_BURST = 60;
/** Every valid message is well under this; anything longer is dropped unread. */
const MAX_MESSAGE_LENGTH = 256;

/**
 * One instance per room code.
 *
 * The roster is not stored: each connection carries its own Player record as a
 * WebSocket attachment, so `getWebSockets()` IS the roster. That means a
 * dropped connection can never leave a ghost player behind, and there is no
 * table to fall out of sync with the live sockets. The room persists its own
 * code, which doubles as "this room was created", so that a made-up code is
 * rejected rather than silently spawning an empty room.
 *
 * Every join and leave is reported to the Directory, which lists the room in
 * the lobby. A room left empty for `EMPTY_ROOM_MS` deletes itself.
 *
 * The one piece of game state is who holds the totem. It is room-wide and must
 * be single-valued, so it lives in storage rather than on an attachment; it is
 * written only when "José" is said or the holder leaves.
 */
export class Room extends DurableObject<Env> {
  /**
   * Message budgets, in memory only: a socket woken from hibernation starts
   * over with a full bucket, which errs on the generous side.
   */
  private readonly budgets = new WeakMap<
    WebSocket,
    { tokens: number; at: number }
  >();

  /**
   * Called over RPC by the Directory when it hands out a code. Idempotent:
   * the Directory calls it again each time the owner asks for their room.
   */
  async create(code: string): Promise<void> {
    await this.ctx.storage.put("code", code);
    // Nobody may ever join; don't keep the room forever if so.
    if (this.roster().length === 0) await this.expireLater();
  }

  /**
   * The WebSocket upgrade. A socket upgrade cannot travel over RPC, so this is
   * the one place the DO uses a fetch handler.
   */
  override async fetch(request: Request): Promise<Response> {
    const code = await this.ctx.storage.get<string>("code");
    if (!code) {
      return this.reject(CloseCode.ROOM_NOT_FOUND, "Room not found");
    }

    const roster = this.roster();
    if (roster.length >= MAX_SEATS) {
      return this.reject(CloseCode.ROOM_FULL, "Room full");
    }

    // Safe without locking: a Durable Object handles one request at a time, so
    // this read-then-claim cannot interleave with another join.
    const seat = pickSeat(new Set(roster.map((p) => p.seat)));

    const name = sanitizeName(new URL(request.url).searchParams.get("name"));
    const player: Player = {
      id: crypto.randomUUID(),
      name,
      seat,
      color: seatColor(seat),
      losses: 0,
    };

    // The first player in starts the game. A holder missing from the roster
    // (a socket that died without a close event) is treated the same way.
    let totem = await this.ctx.storage.get<Totem>("totem");
    if (!totem || !roster.some((p) => p.id === totem!.holder)) {
      totem = { holder: player.id, known: true };
      await this.ctx.storage.put("totem", totem);
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(player);

    this.send(server, {
      t: "welcome",
      you: player,
      players: roster,
      holder: totem.known ? totem.holder : null,
      pooped: totem.pausedUntil !== undefined ? totem.holder : null,
    });
    this.broadcast({ t: "join", player }, server);
    await this.relist(code);

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (!this.spend(ws)) return;
    if (typeof message !== "string" || message.length > MAX_MESSAGE_LENGTH) {
      return;
    }

    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(message) as ClientMessage;
    } catch {
      return;
    }

    const player = ws.deserializeAttachment() as Player | null;
    if (!player) return;

    switch (parsed?.t) {
      case "look": {
        const yaw = wrapAngle(parsed.yaw);
        const pitch = clamp(parsed.pitch, -MAX_PITCH, MAX_PITCH);
        if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return;

        // Deliberately not persisted to the attachment: head angles are stale a
        // frame later, and re-serializing here would mean a write per message.
        this.broadcast({ t: "look", id: player.id, yaw, pitch }, ws);
        return;
      }

      // Who the word is aimed at is passed through as sent: the target may
      // already have left, and every client resolves ids for itself anyway.
      case "say": {
        if (typeof parsed.to !== "string") return;
        if (!isActionId(parsed.action)) return;
        const say: Say = { action: parsed.action };
        if (parsed.action === "number") {
          const n = parsed.n;
          if (!Number.isInteger(n) || n! < 1 || n! > MAX_SEATS) return;
          say.n = n;
        }
        // Nobody can play while the last loser is still being stared at.
        const totemAction = isTotemAction(say.action);
        if (totemAction && (await this.paused())) return;

        this.broadcast({ t: "said", from: player.id, to: parsed.to, ...say }, ws);
        if (totemAction) await this.play(ws, player, say, parsed.to);
        return;
      }

      default:
        return;
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    // With hibernation the runtime doesn't answer the client's close frame,
    // and the browser only fires "close" once it is answered.
    try {
      ws.close(1000, "left");
    } catch {
      // Already closed.
    }
    await this.announceLeave(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.announceLeave(ws);
  }

  /** Delete a room that stayed empty, and take it off the lobby list. */
  override async alarm(): Promise<void> {
    if (this.roster().length > 0) return;
    const code = await this.ctx.storage.get<string>("code");
    await this.ctx.storage.deleteAll();
    if (code) await directory(this.env).remove(code);
  }

  /**
   * The totem rules. Only the holder may play:
   * - "José" passes the totem to the target.
   * - "Michel" sends it back to the giver, and must be aimed at the giver.
   * - "Bi" sends it back to the giver, and must be aimed at anyone else.
   * - A number N calls the Nth player clockwise, the holder being 1. From
   *   then on only the next line of `CALL` may be said, by whoever it is due
   *   from; the last line hands the totem to the called player.
   * - A slurp passes it around the table; see `slurp()`.
   * Any other move -- playing without the totem, Michel/Bi aimed wrongly or
   * with no giver to send back to (the start of a round), saying 1, a line of
   * the call out of turn -- is a loss, and the loser starts the next round
   * holding it.
   *
   * Moves that only fail because someone left (the target, the giver, or
   * enough players for N or a slurp) do nothing: the holder keeps it and
   * nobody loses.
   */
  private async play(
    ws: WebSocket,
    player: Player,
    { action, n }: Say,
    to: string,
  ): Promise<void> {
    const totem = await this.ctx.storage.get<Totem>("totem");
    if (totem?.call) return this.answer(ws, player, action, totem, totem.call);
    if (totem?.holder !== player.id) return this.lose(ws, player);
    if (isCallLine(action)) return this.lose(ws, player);

    const present = (id: string) => this.roster().some((p) => p.id === id);

    if (action === "number") {
      if (n === 1) return this.lose(ws, player);
      const target = aroundTable(player.seat, this.roster(), true)[n! - 1];
      if (!target) return;
      // The totem stays put until the exchange is over. Calling counts as
      // playing, so the last loser is off the hook (see `pausedUntil`).
      const next: Totem = {
        ...totem,
        pausedUntil: undefined,
        call: { callee: target.id, step: 0 },
      };
      await this.ctx.storage.put("totem", next);
      return;
    }

    if (isSlurp(action)) {
      const next = slurp(action, player, this.roster(), totem.clockwise ?? true);
      if (next.to.id === player.id) return;
      await this.pass(totem, next.to.id, player.id, next.clockwise);
      return;
    }

    if (action === "jose") {
      if (to === player.id || !present(to)) return;
      await this.pass(totem, to, player.id);
      return;
    }

    const { giver } = totem;
    if (!giver) return this.lose(ws, player);
    const atGiver = to === giver;
    if (atGiver !== (action === "michel")) return this.lose(ws, player);
    if (!present(giver)) return;
    await this.pass(totem, giver, player.id);
  }

  /** A move during a call: only the next line of `CALL`, from the right player. */
  private async answer(
    ws: WebSocket,
    player: Player,
    action: ActionId,
    totem: Totem,
    call: Call,
  ): Promise<void> {
    const line = CALL[call.step]!;
    const due = line.from === "callee" ? call.callee : totem.holder;
    if (player.id !== due || action !== line.action) return this.lose(ws, player);

    if (call.step + 1 < CALL.length) {
      const next: Totem = { ...totem, call: { ...call, step: call.step + 1 } };
      await this.ctx.storage.put("totem", next);
      return;
    }
    await this.pass(totem, call.callee, totem.holder);
  }

  /** A successful move: from here on, nobody is told who holds it. */
  private async pass(
    totem: Totem,
    holder: string,
    giver: string,
    clockwise = totem.clockwise,
  ): Promise<void> {
    const next: Totem = { holder, giver, known: false, clockwise };
    await this.ctx.storage.put("totem", next);
  }

  private async lose(ws: WebSocket, player: Player): Promise<void> {
    player.losses += 1;
    ws.serializeAttachment(player);
    await this.ctx.storage.put("totem", {
      holder: player.id,
      known: true,
      pausedUntil: Date.now() + LOSS_PAUSE_MS,
    });
    this.broadcast({ t: "lost", id: player.id, losses: player.losses });
  }

  private async paused(): Promise<boolean> {
    const totem = await this.ctx.storage.get<Totem>("totem");
    return Date.now() < (totem?.pausedUntil ?? 0);
  }

  private async announceLeave(ws: WebSocket): Promise<void> {
    const player = ws.deserializeAttachment() as Player | null;
    if (!player) return;
    this.broadcast({ t: "leave", id: player.id }, ws);

    const code = await this.ctx.storage.get<string>("code");
    if (code) await this.relist(code, ws);

    const totem = await this.ctx.storage.get<Totem>("totem");
    // A called player who leaves calls the call off; the caller keeps it.
    if (totem?.call?.callee === player.id) {
      const next: Totem = { ...totem, call: undefined };
      await this.ctx.storage.put("totem", next);
      return;
    }
    if (totem?.holder !== player.id) return;

    // The closing socket can still be listed by getWebSockets().
    const others = this.roster(ws);
    if (others.length === 0) {
      await this.ctx.storage.delete("totem");
      return;
    }
    const holder = others[Math.floor(Math.random() * others.length)]!.id;
    await this.ctx.storage.put("totem", { holder, known: true });
    this.broadcast({ t: "round", holder }, ws);
  }

  /** Tell the Directory who is in the room now; start the clock if nobody is. */
  private async relist(code: string, leaving?: WebSocket): Promise<void> {
    const roster = this.roster(leaving);
    if (roster.length === 0) await this.expireLater();
    await directory(this.env).update(
      code,
      roster.map((p) => p.name),
    );
  }

  private async expireLater(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + EMPTY_ROOM_MS);
  }

  /** Take one message from the socket's budget; false when it is spent. */
  private spend(ws: WebSocket): boolean {
    const now = Date.now();
    const budget = this.budgets.get(ws) ?? { tokens: MESSAGE_BURST, at: now };
    budget.tokens = Math.min(
      MESSAGE_BURST,
      budget.tokens + ((now - budget.at) / 1000) * MESSAGE_RATE,
    );
    budget.at = now;
    this.budgets.set(ws, budget);
    if (budget.tokens < 1) return false;
    budget.tokens -= 1;
    return true;
  }

  /** The live roster, read straight off the open sockets. */
  private roster(except?: WebSocket): Player[] {
    const players: Player[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const player = ws.deserializeAttachment() as Player | null;
      if (player) players.push(player);
    }
    return players;
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  private broadcast(message: ServerMessage, except?: WebSocket): void {
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }

  /**
   * Complete the upgrade, then immediately close with an application code. The
   * browser only surfaces a close code once the handshake has succeeded, so
   * refusing with an HTTP error would reach the client as an opaque failure.
   */
  private reject(code: number, reason: string): Response {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.close(code, reason);
    return new Response(null, { status: 101, webSocket: client });
  }
}

/** Who holds the totem, and whether everyone has been told (true until the
 * first pass of a round). */
interface Totem {
  holder: string;
  /** Who passed it to the holder; absent at the start of a round. */
  giver?: string;
  known: boolean;
  /**
   * Epoch ms; set after a loss, when "José" is ignored for a moment. It is
   * dropped on the first pass, so while present it also means the loser hasn't
   * played yet (and still wears the poop).
   */
  pausedUntil?: number;
  /** Rotation for slurp up; absent (clockwise) at the start of a round. */
  clockwise?: boolean;
  /** A number has been called and the exchange is under way. */
  call?: Call;
}

interface Call {
  callee: string;
  /** Index into `CALL` of the line due next. */
  step: number;
}

/**
 * The exchange after a number is called, line by line. The caller is the
 * holder; the totem moves to the callee after the last line.
 */
const CALL: { from: "caller" | "callee"; action: ActionId }[] = [
  { from: "callee", action: "yes" },
  { from: "caller", action: "want" },
  { from: "callee", action: "yes" },
  { from: "caller", action: "how-many" },
];

function isCallLine(action: ActionId): boolean {
  return CALL.some((line) => line.action === action);
}

/**
 * Choose the free seat furthest from everyone already sitting down.
 *
 * Filling seats in order would sit the second player right beside the first,
 * roughly 67 degrees off-centre -- outside the camera's field of view, so a
 * two-player room would look empty until someone thought to turn their head.
 * Spreading players out puts the second arrival straight across the table.
 */
function pickSeat(taken: Set<number>): number {
  let best = 0;
  let bestDistance = -1;

  for (let seat = 0; seat < MAX_SEATS; seat++) {
    if (taken.has(seat)) continue;

    let nearest = MAX_SEATS;
    for (const other of taken) {
      const gap = Math.abs(seat - other);
      nearest = Math.min(nearest, Math.min(gap, MAX_SEATS - gap));
    }

    if (nearest > bestDistance) {
      bestDistance = nearest;
      best = seat;
    }
  }
  return best;
}

/**
 * Players in order around the table, seen from above, starting at `seat`.
 * Seat indices grow counterclockwise (seat 2 sits on seat 0's right; see
 * `seatPosition` in src/scene/seats.ts), so clockwise counts them down -- and
 * the next player clockwise is the one on your left.
 */
function aroundTable<T extends { seat: number }>(
  seat: number,
  players: T[],
  clockwise: boolean,
): T[] {
  const steps = (p: T) =>
    ((clockwise ? seat - p.seat : p.seat - seat) + MAX_SEATS) % MAX_SEATS;
  return [...players].sort((a, b) => steps(a) - steps(b));
}

/**
 * Where a slurp sends the totem, and which way the rotation turns afterwards.
 * With too few players this can land back on `from`.
 */
function slurp<T extends { seat: number }>(
  action: SlurpAction,
  from: T,
  players: T[],
  clockwise: boolean,
): { to: T; clockwise: boolean } {
  if (action === "slurp-left") clockwise = true;
  if (action === "slurp-right") clockwise = false;
  const order = aroundTable(from.seat, players, clockwise);
  const skip = action === "slurp-up" ? 2 : 1;
  return { to: order[skip % order.length]!, clockwise };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function wrapAngle(value: number): number {
  const twoPi = Math.PI * 2;
  return ((value + Math.PI) % twoPi + twoPi) % twoPi - Math.PI;
}
