# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

"Party Room" — a prototype first-person 3D room for a web party game. Players create a
room, share a 4-character code, and everyone who joins appears seated around a table.
Mouse-look only; there is no movement, no game rules, and no persistence.

## Commands

```sh
pnpm install
pnpm dev         # Vite dev server; the Cloudflare plugin runs the Worker + DO in workerd
pnpm build       # deployable bundle into dist/
pnpm preview     # serve the built bundle in the Workers runtime
pnpm typecheck   # BOTH tsconfigs — the only check in the repo
pnpm deploy      # vite build && wrangler deploy (needs a Cloudflare login)
```

There is no test suite, linter, or formatter. `pnpm typecheck` is the gate: it runs
`tsc` twice, once per tsconfig, because the browser and Worker halves have disjoint
`lib`/`types` (`DOM` vs `@cloudflare/workers-types`). A change touching `shared/` must
typecheck under both. Both configs are `strict` with `noUnusedLocals`,
`noUnusedParameters`, and `verbatimModuleSyntax` — import types with `import type`.

To exercise multiplayer locally, open the dev URL in two windows (one private) and join
the same code.

## Architecture

One Worker serves both the client bundle and the API. Each room code maps to a Durable
Object instance that owns that room's WebSockets; one global `Directory` DO lists the
open rooms.

```
browser ──WS── worker/index.ts (router) ──getByName(code)── Room DO (worker/room.ts)
   └─HTTP /api/rooms── router ──getByName("global")── Directory DO (worker/directory.ts)
```

- `shared/protocol.ts` is imported by **both** sides — message types, close codes, seat
  count, pitch limit, name sanitizing, seat palette. Anything both halves must agree on
  belongs here rather than being restated on either side.
- `worker/index.ts` — `POST /api/rooms` asks the Directory for the caller's room
  (`claim()`), `GET /api/rooms` lists open rooms (the lobby polls it every 3s);
  `/api/rooms/:code/ws` routes the upgrade; everything else falls through to `ASSETS`.
- `worker/directory.ts` — the lobby listing (SQLite table `rooms`). **One room per
  owner**: the owner is the client IP (`ownerKey()`, IPv6 by /64), and `claim()` hands
  back the owner's existing room rather than minting a second. It is a listing, not the
  source of truth: rooms report themselves via `update()` on every join/leave and
  `remove()` on expiry, and `claim()` re-runs the idempotent `Room.create()` so a room
  that vanished without reporting is revived.
  `wrangler.jsonc` sets `run_worker_first: ["/api/*"]`, so only those paths reach the
  Worker before static assets.
- `worker/room.ts` — the room. **The roster is not stored.** Each connection carries its
  `Player` record as a WebSocket attachment, so `ctx.getWebSockets()` *is* the roster; a
  dropped socket cannot leave a ghost. Persisted keys: `"code"`, which also marks the
  room as created so a made-up code is rejected instead of silently spawning an empty
  room, and `"totem"`
  (`{ holder, known }`), the one piece of room-wide game state — see `Room.play()`.
  Per-player losses live on the attachment. Keep
  new per-connection state on the attachment; keep per-room state minimal and remember
  that a DO handles one request at a time (so read-then-claim, e.g. seat picking, needs
  no locking).

### Conventions worth preserving

- **Failures are WebSocket close codes, not messages.** `Room.reject()` completes the
  101 upgrade and then closes with a 4xxx code, because a browser only surfaces a close
  code after a successful handshake — an HTTP error would reach the client as opaque.
  The client has exactly one failure path: `closeReason()` in `shared/protocol.ts`.
- **Seat geometry lives in one place.** `src/scene/seats.ts` is read by both the local
  camera and remote avatars, so your view and everyone else's view of you agree by
  construction. Angles go on the wire in the sender's own frame; `Avatar.setLook()`
  subtracts the seat's facing. Don't hand-match a second copy of these constants.
- **Seats are spread, not filled in order** (`pickSeat` in `worker/room.ts`): the second
  player sits opposite you and is visible without turning.
- A room left empty for `EMPTY_ROOM_MS` deletes itself in `Room.alarm()` and leaves
  the Directory; any join/leave/create re-arms or outlives that alarm.
- Client messages are capped server-side: `MAX_MESSAGE_LENGTH` and a per-socket token
  bucket (`MESSAGE_RATE`/`MESSAGE_BURST`, in memory only) in `worker/room.ts`. Excess is
  dropped silently. Keep the bucket above what a well-behaved client sends.
- Look updates are throttled and deduped client-side in `src/net.ts` (~15/s, epsilon on
  the angle) and are deliberately *not* persisted to the attachment server-side — that
  would be a storage write per message.
- The scene is entirely three.js primitives with no loaded assets (`src/scene/world.ts`,
  `avatar.ts`). Keep it that way unless there's a reason not to; there is no asset
  pipeline.
- **Aim-and-say is three pieces that meet in `main.ts`.** `World` picks the avatar
  nearest the crosshair each frame by *screen-space* proximity (not a raycast — see
  `pickTarget`) and reports target changes; `src/actionPicker.ts` owns the input — the
  mouse only aims; click/Space opens the menu and says the selection, A/D cycle
  `ACTIONS`, right click/Esc go back (out of the "Number…" list, 1..player count, then
  out of the menu). No scroll wheel, so a trackpad is enough. The menu stays open while
  the target changes: the action is said to whoever is aimed at on confirm. `Ui` draws
  it as a carousel. The action list lives in `shared/protocol.ts` so adding a plain
  action is a single edit there; the rules for each one are in `Room.play()`. Order around
  the table is `aroundTable()` / `slurp()` in `worker/room.ts` — seat indices grow
  counterclockwise, so your left neighbour is next clockwise. The slurp hand only
  gestures in front of the thrower; the client never computes where the totem went. The picker's click listener
  shares the canvas with pointer lock's — that is safe only because
  `requestPointerLock` resolves asynchronously, so the capturing click sees `isLocked`
  as false.
- `src/main.ts` owns all cross-cutting state (connection, `you`, roster) and wires
  net → world → ui. `src/ui.ts` touches the DOM overlay declared in `index.html` and
  nothing else; `World` and `LookControls` never touch the DOM overlay or the socket.
- `onClose` in `src/main.ts` guards `connection !== session` so a stale socket losing a
  race cannot tear down the room a newer one just set up. Preserve that check if you
  add reconnect logic.
