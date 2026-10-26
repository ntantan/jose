# Party Room — prototype

First-person 3D room for a web party game. You create a room, share the 4-character
code, and everyone who joins appears seated around the table. Mouse-look only —
there is no movement.

## Run it

```sh
pnpm install
pnpm dev
```

Open the printed URL, enter a name, and click **Create a room**. Open a second
browser window (a private window works), enter the code, and the two of you will
be sitting across the table from each other. Click the canvas to capture the
mouse and look around; `Esc` releases it.

`pnpm build` produces the deployable bundle, `pnpm preview` runs it in the
Workers runtime, and `pnpm deploy` ships it (needs a Cloudflare login).

## How it fits together

One Worker serves both the client and the API. Each room code maps to a
Durable Object instance that owns that room's WebSockets.

```
browser ──WS── Worker (router) ──stub.fetch()── Room DO   (one per room code)
```

- `shared/protocol.ts` — the wire format, imported by both sides so they cannot drift.
- `worker/index.ts` — mints room codes, routes the WebSocket upgrade.
- `worker/room.ts` — the room. The roster is not stored anywhere: each connection
  carries its own player record as a WebSocket attachment, so the set of open
  sockets *is* the roster and a dropped connection cannot leave a ghost behind.
- `src/scene/seats.ts` — seat ring geometry, read by both your camera and everyone
  else's avatar so the two views agree by construction.
- `src/scene/` — the room, avatars, and pointer-lock look, all primitive geometry
  with no assets to load.

Seats are assigned to spread players around the ring rather than filling in order,
so the second person to join sits opposite you and is visible without turning.

## Not built yet

Movement, game rules, audio, reconnect-on-drop, and persistence once a room empties.
# jose
