/**
 * Wire protocol shared by the Worker and the browser client.
 * Both sides import these types so the two can never drift.
 */

/** Seats in a room. Also the number of avatar colors. */
export const MAX_SEATS = 8;

/** Room codes use an alphabet without I/O/0/1 so they can be read aloud. */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 4;

export const MAX_NAME_LENGTH = 16;

/** Vertical look limit, radians. Matches the client's camera clamp. */
export const MAX_PITCH = (85 * Math.PI) / 180;

export interface Player {
  id: string;
  name: string;
  seat: number;
  /** Packed RGB, derived from the seat index. */
  color: number;
  /** Times this player said "José" without holding the totem. */
  losses: number;
}

/**
 * What you can say at whoever you are looking at. The order is the order A/D
 * cycle through them in the action menu. `totem` actions are moves in the game
 * (the room judges them); the others are just talk.
 *
 * - José: pass the totem to whoever you are looking at.
 * - Michel: send it back to whoever gave it to you, looking at them.
 * - Bi: send it back to whoever gave it to you, looking at anyone else.
 * - Number: call player N, counting clockwise from the holder (who is 1).
 *   Who you look at doesn't matter. It opens a submenu to pick N. The totem
 *   only moves once the exchange is played out, in this order:
 *   N: "Oui" -> caller: "T'en veux ?" -> N: "Oui" -> caller: "Combien ?".
 *   See `CALL` in worker/room.ts.
 * - Slurp left / right: pass it to your neighbour on that side, and turn the
 *   rotation that way. Slurp up: skip one, in the current rotation (clockwise
 *   at the start of every round). See `slurp()` in worker/room.ts.
 */
export const ACTIONS = [
  { id: "hello", label: "Hello", totem: false },
  { id: "jose", label: "José", totem: true },
  { id: "michel", label: "Michel", totem: true },
  { id: "bi", label: "Bi", totem: true },
  { id: "number", label: "Number…", totem: true },
  { id: "yes", label: "Oui", totem: true },
  { id: "want", label: "T'en veux ?", totem: true },
  { id: "how-many", label: "Combien ?", totem: true },
  { id: "slurp-left", label: "Slurp left", totem: true },
  { id: "slurp-up", label: "Slurp up", totem: true },
  { id: "slurp-right", label: "Slurp right", totem: true },
] as const;

export type ActionId = (typeof ACTIONS)[number]["id"];
export type SlurpAction = Extract<ActionId, `slurp-${string}`>;

export function isSlurp(id: ActionId): id is SlurpAction {
  return id.startsWith("slurp-");
}

export function isTotemAction(id: ActionId): boolean {
  return ACTIONS.find((action) => action.id === id)!.totem;
}

/** How long a spoken word stays above an avatar. */
export const SPEECH_MS = 2500;

/**
 * After a loss, how long everyone gets to look at the loser before the next
 * round starts. "José" is ignored until then.
 */
export const LOSS_PAUSE_MS = 3000;

/** Something said: an action, plus which number when the action is "number". */
export interface Say {
  action: ActionId;
  n?: number;
}

/** What a speech bubble shows: the number itself, or the action's name. */
export function sayLabel(say: Say): string {
  if (say.n !== undefined) return String(say.n);
  return ACTIONS.find((action) => action.id === say.action)!.label;
}

export function isActionId(value: unknown): value is ActionId {
  return ACTIONS.some((action) => action.id === value);
}

/** An open room as the lobby lists it (`GET /api/rooms`). */
export interface RoomSummary {
  code: string;
  /** Who is in it, in no particular order; its length is the head count. */
  names: string[];
}

/** Messages the browser sends to the room. */
export type ClientMessage =
  | { t: "look"; yaw: number; pitch: number }
  | ({ t: "say"; to: string } & Say);

/** Messages the room sends to the browser. */
export type ServerMessage =
  /**
   * `holder` is only revealed while nobody has passed the totem yet this round.
   * `pooped` is the last loser, if they haven't passed it on yet.
   */
  | {
      t: "welcome";
      you: Player;
      players: Player[];
      holder: string | null;
      pooped: string | null;
    }
  | { t: "join"; player: Player }
  | { t: "leave"; id: string }
  | { t: "look"; id: string; yaw: number; pitch: number }
  | ({ t: "said"; from: string; to: string } & Say)
  /** Someone said "José" without the totem. The loser holds it and starts. */
  | { t: "lost"; id: string; losses: number }
  /** A new round without a loss (the holder left); `holder` starts. */
  | { t: "round"; holder: string };

/**
 * Failures are delivered as WebSocket close codes rather than as messages, so
 * the client has a single failure path instead of two. 4xxx is the range
 * reserved for application use.
 */
export const CloseCode = {
  ROOM_NOT_FOUND: 4404,
  ROOM_FULL: 4403,
  BAD_REQUEST: 4400,
} as const;

export function closeReason(code: number): string {
  switch (code) {
    case CloseCode.ROOM_NOT_FOUND:
      return "That room code doesn't exist.";
    case CloseCode.ROOM_FULL:
      return `That room is full (${MAX_SEATS} players max).`;
    case CloseCode.BAD_REQUEST:
      return "The server rejected the connection.";
    default:
      return "Disconnected from the room.";
  }
}

/** Distinct hues so seats are told apart at a glance. */
const SEAT_PALETTE = [
  0xe6547a, 0x4fb3e8, 0x63c98a, 0xf2b134, 0xa87ce0, 0xef7d4e, 0x3fc4c0,
  0xd45fd0,
];

export function seatColor(seat: number): number {
  return SEAT_PALETTE[seat % SEAT_PALETTE.length]!;
}

export function isValidCode(code: string): boolean {
  if (code.length !== CODE_LENGTH) return false;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return false;
  return true;
}

/** Drop control characters and clamp length. Applied server-side on join. */
export function sanitizeName(raw: string | null): string {
  const printable = Array.from(raw ?? "").filter((ch) => {
    const cp = ch.codePointAt(0)!;
    return cp >= 0x20 && cp !== 0x7f;
  });
  const cleaned = printable.join("").trim().slice(0, MAX_NAME_LENGTH);
  return cleaned || "Player";
}
