import "./style.css";
import {
  isSlurp,
  isTotemAction,
  LOSS_PAUSE_MS,
  sayLabel,
  type Player,
  type Say,
} from "../shared/protocol";
import { ActionPicker } from "./actionPicker";
import { createRoom, listRooms, RoomConnection } from "./net";
import { Ui } from "./ui";
import { LookControls } from "./scene/lookControls";
import { seatFacing } from "./scene/seats";
import { World } from "./scene/world";

const canvas = document.getElementById("scene") as HTMLCanvasElement;
const world = new World(canvas);
const look = new LookControls(world.camera, canvas);
const picker = new ActionPicker(
  canvas,
  () => look.isLocked,
  () => roster.length,
);

let connection: RoomConnection | null = null;
let you: Player | null = null;
/** Everyone in the room including you; the HUD list is rendered from this. */
let roster: Player[] = [];
/** Pending "next round" announcement after a loss; "José" is held until then. */
let pauseTimer: number | undefined;

/** How often the lobby re-fetches the open rooms. */
const ROOMS_POLL_MS = 3000;

const ui = new Ui({
  onCreate: async (name) => {
    ui.setBusy(true);
    try {
      const code = await createRoom();
      connect(code, name);
    } catch {
      ui.setBusy(false);
      ui.showError("Could not create a room. Is the server running?");
    }
  },
  onJoin: (code, name) => {
    ui.setBusy(true);
    connect(code, name);
  },
  onLeave: () => {
    connection?.close();
  },
});

/** Only while the lobby is on screen: in a room, or in a background tab, the list isn't seen. */
async function refreshRooms(): Promise<void> {
  if (connection || document.hidden) return;
  try {
    const rooms = await listRooms();
    if (!connection) ui.renderRooms(rooms);
  } catch {
    // Keep showing the last list; the next poll will try again.
  }
}

void refreshRooms();
window.setInterval(() => void refreshRooms(), ROOMS_POLL_MS);

look.onLock((locked) => {
  // The hint is only useful while in a room and not already looking around.
  if (you) ui.setHintVisible(!locked);
  // Aiming is crosshair-based, so it only means anything once the mouse is
  // captured -- releasing it drops the target rather than leaving one stuck.
  setAiming(Boolean(you) && locked);
  if (!locked) picker.close();
});

world.setTargetCallback((target) => picker.setTarget(target));

picker.onChange((state) => ui.showActionMenu(state));

picker.onConfirm((target, say) => {
  // The room ignores it during the pause, and the "lost" banner is still up,
  // so swallowing it here doesn't leave anyone wondering.
  if (isTotemAction(say.action) && pauseTimer !== undefined) return;
  connection?.sendSay(target.id, say);
  // Playing is what takes the poop off.
  if (isTotemAction(say.action) && you) world.clearPoop(you.id);
  // The room broadcasts to everyone else, so the sender echoes it locally.
  if (you) showSaid(you.id, target.id, say);
  if (you && isSlurp(say.action)) world.slurpHand(you.seat, say.action);
});

/** The reticle and the targeting behind it come and go together; dropping the
 * target is what closes the menu. */
function setAiming(enabled: boolean): void {
  world.setAimingEnabled(enabled);
  ui.setCrosshairVisible(enabled);
}

// Sampled every frame; the connection throttles and dedupes before sending.
world.setFrameCallback(() => {
  connection?.sendLook(look.yaw, look.pitch);
});

function clearPause(): void {
  if (pauseTimer !== undefined) clearTimeout(pauseTimer);
  pauseTimer = undefined;
}

function nameOf(id: string): string {
  return roster.find((player) => player.id === id)?.name ?? "Someone";
}

/** "Alice → Bob: José", with you named as such on either side. */
function showSaid(from: string, to: string, say: Say): void {
  const sender = roster.find((player) => player.id === from);
  if (!sender) return;
  const who = from === you?.id ? "You" : sender.name;
  const whom = to === you?.id ? "you" : nameOf(to);
  ui.flashSaid(sender, `${who} → ${whom}: ${sayLabel(say)}`, to === you?.id);
}

/** Only said at the start of a round; after the first pass, nobody is told. */
function announceHolder(id: string): void {
  ui.announce(
    id === you?.id ? "You have the totem." : `${nameOf(id)} has the totem.`,
  );
}

function connect(code: string, name: string): void {
  connection?.close();

  const session = new RoomConnection(code, name);
  connection = session;

  session.on("welcome", ({ you: me, players, holder, pooped }) => {
    you = me;
    roster = [...players, me];

    world.clearPlayers();
    for (const player of players) world.addPlayer(player);
    world.seatCamera(me.seat);
    if (pooped) world.dropPoopOn(pooped, false);

    look.reset(seatFacing(me.seat));
    look.setEnabled(true);

    ui.enterRoom(code);
    ui.renderPlayers(roster, me.id);
    ui.setHintVisible(!look.isLocked);
    if (holder) announceHolder(holder);
  });

  session.on("join", ({ player }) => {
    world.addPlayer(player);
    roster = [...roster, player];
    if (you) ui.renderPlayers(roster, you.id);
  });

  session.on("leave", ({ id }) => {
    world.removePlayer(id);
    roster = roster.filter((player) => player.id !== id);
    if (you) ui.renderPlayers(roster, you.id);
  });

  session.on("look", ({ id, yaw, pitch }) => {
    world.setPlayerLook(id, yaw, pitch);
  });

  session.on("said", ({ from, to, action, n }) => {
    const say: Say = { action, n };
    world.playerSays(from, sayLabel(say), to === you?.id);
    if (isTotemAction(action)) world.clearPoop(from);
    showSaid(from, to, say);
    if (isSlurp(action)) {
      const sender = roster.find((player) => player.id === from);
      if (sender) world.slurpHand(sender.seat, action);
    }
  });

  session.on("lost", ({ id, losses }) => {
    roster = roster.map((player) =>
      player.id === id ? { ...player, losses } : player,
    );
    if (you) ui.renderPlayers(roster, you.id);

    if (id === you?.id) world.dropPoopOnYou(id);
    else world.dropPoopOn(id);
    ui.announce(id === you?.id ? "You lost!" : `${nameOf(id)} lost!`);

    // Give everyone a moment to see who lost before the loser starts again.
    clearPause();
    pauseTimer = window.setTimeout(() => {
      pauseTimer = undefined;
      // If the loser left meanwhile, a "round" message has already named the
      // new holder.
      if (roster.some((player) => player.id === id)) announceHolder(id);
    }, LOSS_PAUSE_MS);
  });

  session.on("round", ({ holder }) => {
    clearPause();
    announceHolder(holder);
  });

  session.onClose((reason, wasExpected) => {
    // A stale socket losing its race with a newer one must not tear down the
    // room the newer one just set up.
    if (connection !== session) return;

    connection = null;
    you = null;
    roster = [];
    clearPause();

    world.clearPlayers();
    look.setEnabled(false);
    setAiming(false);
    ui.leaveRoom();
    if (!wasExpected) ui.showError(reason);
    void refreshRooms();
  });
}
