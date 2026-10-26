import { DurableObject } from "cloudflare:workers";
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  type RoomSummary,
} from "../shared/protocol";
import type { Env } from "./index";

/** The single Directory instance. */
export function directory(env: Env) {
  return env.DIRECTORY.getByName("global");
}

/**
 * The global list of open rooms: what the lobby shows, and what keeps each
 * owner (a client address, see `ownerKey` in worker/index.ts) to one room.
 *
 * Rooms report themselves -- `update()` on every join and leave, `remove()`
 * once they expire empty (`Room.alarm()`) -- so this is a listing, not the
 * source of truth: a room that exists is whatever its own DO says. One
 * instance means every creation and lobby poll goes through one object, which
 * is plenty at party-game scale.
 */
export class Directory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // `owner` is NULL for a row re-listed by `update()` after its owner's row
    // was already removed; such a room counts against nobody.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS rooms (
      code TEXT PRIMARY KEY,
      owner TEXT UNIQUE,
      names TEXT NOT NULL DEFAULT '[]'
    )`);
  }

  /**
   * The owner's room, minted on their first call and handed back on every
   * call after that until it expires. The check and the insert are both
   * synchronous, so two concurrent claims from one owner cannot both mint.
   */
  async claim(owner: string): Promise<string> {
    const row = this.ctx.storage.sql
      .exec<{ code: string }>("SELECT code FROM rooms WHERE owner = ?", owner)
      .toArray()[0];
    const code = row?.code ?? this.freeCode();
    if (!row) {
      this.ctx.storage.sql.exec(
        "INSERT INTO rooms (code, owner) VALUES (?, ?)",
        code,
        owner,
      );
    }
    // Idempotent on a live room; recreates one that expired without telling us.
    await this.env.ROOM.getByName(code).create(code);
    return code;
  }

  list(): RoomSummary[] {
    return this.ctx.storage.sql
      .exec<{ code: string; names: string }>(
        "SELECT code, names FROM rooms ORDER BY rowid",
      )
      .toArray()
      .map((row) => ({ code: row.code, names: JSON.parse(row.names) }));
  }

  update(code: string, names: string[]): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO rooms (code, names) VALUES (?, ?)
       ON CONFLICT (code) DO UPDATE SET names = excluded.names`,
      code,
      JSON.stringify(names),
    );
  }

  remove(code: string): void {
    this.ctx.storage.sql.exec("DELETE FROM rooms WHERE code = ?", code);
  }

  private freeCode(): string {
    for (;;) {
      const code = randomCode();
      const taken = this.ctx.storage.sql
        .exec("SELECT 1 FROM rooms WHERE code = ?", code)
        .toArray().length;
      if (!taken) return code;
    }
  }
}

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let code = "";
  for (const b of bytes) {
    code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  }
  return code;
}
