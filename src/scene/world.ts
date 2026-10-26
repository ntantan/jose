import * as THREE from "three";
import {
  MAX_SEATS,
  type Player,
  type SlurpAction,
} from "../../shared/protocol";
import { Avatar, HEAD_TOP } from "./avatar";
import { Hand } from "./hand";
import { Poop } from "./poop";
import { SEAT_RADIUS, seatEye, seatFacing, seatPosition } from "./seats";

const ROOM_SIZE = 8;
const ROOM_HEIGHT = 3.2;
const TABLE_RADIUS = 1.35;
const TABLE_HEIGHT = 0.78;

/**
 * How close to the crosshair a head has to be to count as aimed at, as a
 * fraction of the smaller viewport dimension. Generous on purpose: heads are
 * small across the table, and "near enough" is what the player means.
 */
const AIM_RADIUS = 0.14;

/** A slurp hand starts this far ahead of the thrower, above the table edge. */
const HAND_AHEAD = 0.65;
const HAND_HEIGHT = TABLE_HEIGHT + 0.22;
/** How far the gesture goes: a flick to the side, or up. */
const HAND_SWEEP = 0.4;
const HAND_RAISE = 0.45;

/** How far above its landing spot a poop starts falling. */
const POOP_DROP = 1.6;
/** Where a poop on you lands: ahead of your eyes and a little below them. */
const POOP_ON_YOU_AHEAD = 0.55;
const POOP_ON_YOU_BELOW = 0.32;

/**
 * The room, built entirely from primitives so there are no assets to load and
 * nothing to go missing on first paint.
 */
export class World {
  readonly camera: THREE.PerspectiveCamera;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly avatars = new Map<string, Avatar>();
  /** Only the latest loser wears one; `wearer` may be you. */
  private poop?: { wearer: string; poop: Poop };
  private readonly hands = new Set<Hand>();
  private lastFrame = performance.now();
  private onFrame?: () => void;

  private aiming = false;
  private targetId: string | null = null;
  private onTarget?: (player: Player | null) => void;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.camera = new THREE.PerspectiveCamera(75, 1, 0.1, 100);
    // A default vantage point so the lobby has something behind it.
    this.camera.position.copy(seatEye(0));
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.y = seatFacing(0);

    this.scene.background = new THREE.Color(0x0f1117);
    this.buildRoom();
    this.buildTable();
    this.buildChairs();

    this.handleResize();
    window.addEventListener("resize", this.handleResize);
    this.renderer.setAnimationLoop(this.tick);
  }

  /** Called once per rendered frame, before the draw. */
  setFrameCallback(callback: () => void): void {
    this.onFrame = callback;
  }

  /** Called whenever the player under the crosshair changes. */
  setTargetCallback(callback: (player: Player | null) => void): void {
    this.onTarget = callback;
  }

  /** Aiming only makes sense while the mouse is captured. */
  setAimingEnabled(enabled: boolean): void {
    this.aiming = enabled;
    if (!enabled) this.setTarget(null);
  }

  seatCamera(seat: number): void {
    this.camera.position.copy(seatEye(seat));
  }

  addPlayer(player: Player): void {
    if (this.avatars.has(player.id)) return;
    const avatar = new Avatar(player);
    this.avatars.set(player.id, avatar);
    this.scene.add(avatar.group);
  }

  removePlayer(id: string): void {
    const avatar = this.avatars.get(id);
    if (!avatar) return;
    if (this.targetId === id) this.setTarget(null);
    // The poop goes with the avatar it sits on.
    if (this.poop?.wearer === id) this.poop = undefined;
    avatar.dispose();
    this.avatars.delete(id);
  }

  setPlayerLook(id: string, yaw: number, pitch: number): void {
    this.avatars.get(id)?.setLook(yaw, pitch);
  }

  /** Put a word above a player's head. */
  playerSays(id: string, text: string, atYou: boolean): void {
    this.avatars.get(id)?.say(text, atYou);
  }

  /**
   * Drop a poop on another player's head. `falling: false` puts it straight
   * there, for someone who was already wearing one when you arrived.
   */
  dropPoopOn(id: string, falling = true): void {
    const avatar = this.avatars.get(id);
    if (!avatar) return;
    const poop = new Poop(HEAD_TOP, falling ? POOP_DROP : 0);
    avatar.group.add(poop.group);
    this.setPoop(id, poop);
  }

  /**
   * Drop a poop on yourself. Your own avatar isn't drawn, so it lands just in
   * front of your eyes, in the direction you are facing, where you can see it.
   */
  dropPoopOnYou(youId: string): void {
    const forward = this.camera.getWorldDirection(new THREE.Vector3());
    forward.y = 0;
    forward.normalize();

    const poop = new Poop(this.camera.position.y - POOP_ON_YOU_BELOW, POOP_DROP);
    poop.group.position.x = this.camera.position.x + forward.x * POOP_ON_YOU_AHEAD;
    poop.group.position.z = this.camera.position.z + forward.z * POOP_ON_YOU_AHEAD;
    this.scene.add(poop.group);
    this.setPoop(youId, poop);
  }

  /**
   * The slurp gesture: a hand in front of the thrower flicking to their left,
   * right, or up. It stays at their seat -- where the totem lands is for the
   * others to work out.
   */
  slurpHand(seat: number, action: SlurpAction): void {
    // The seat's view direction (see seatFacing) and the thrower's right.
    const t = seatFacing(seat);
    const forward = new THREE.Vector3(-Math.sin(t), 0, -Math.cos(t));
    const right = new THREE.Vector3(Math.cos(t), 0, -Math.sin(t));

    const from = seatPosition(seat)
      .addScaledVector(forward, HAND_AHEAD)
      .setY(HAND_HEIGHT);
    const to = from.clone();
    if (action === "slurp-up") to.y += HAND_RAISE;
    else to.addScaledVector(right, action === "slurp-right" ? HAND_SWEEP : -HAND_SWEEP);

    const hand = new Hand(from, to, action === "slurp-up" ? 0 : 0.05);
    this.scene.add(hand.group);
    this.hands.add(hand);
  }

  /** Take the poop off someone, if they are the one wearing it. */
  clearPoop(id: string): void {
    if (this.poop?.wearer === id) this.removePoop();
  }

  /** A new loser takes the poop from the previous one. */
  private setPoop(wearer: string, poop: Poop): void {
    this.removePoop();
    this.poop = { wearer, poop };
  }

  private removePoop(): void {
    this.poop?.poop.group.removeFromParent();
    this.poop = undefined;
  }

  clearPlayers(): void {
    this.setTarget(null);
    for (const avatar of this.avatars.values()) avatar.dispose();
    this.avatars.clear();
    this.removePoop();
    for (const hand of this.hands) hand.group.removeFromParent();
    this.hands.clear();
  }

  private tick = (): void => {
    const now = performance.now();
    const dt = Math.min((now - this.lastFrame) / 1000, 0.1);
    this.lastFrame = now;
    this.poop?.poop.update(dt);
    for (const hand of this.hands) if (!hand.update(dt)) this.hands.delete(hand);

    if (this.aiming) this.setTarget(this.pickTarget());
    this.onFrame?.();
    this.renderer.render(this.scene, this.camera);
  };

  /**
   * The avatar whose head lands nearest the crosshair, if any is near enough.
   *
   * Screen-space proximity rather than a ray: it matches what the player is
   * doing (pointing roughly at someone) and stays forgiving at table distance,
   * where a head is only a few dozen pixels across.
   */
  private pickTarget(): string | null {
    this.camera.updateMatrixWorld();

    const { innerWidth: w, innerHeight: h } = window;
    let nearest: string | null = null;
    let nearestDistance = Math.min(w, h) * AIM_RADIUS;

    for (const avatar of this.avatars.values()) {
      const ndc = avatar.headPosition().project(this.camera);
      if (ndc.z > 1) continue; // Behind the camera.

      // NDC is centred on the crosshair, so this is the offset from it.
      const distance = Math.hypot((ndc.x * w) / 2, (ndc.y * h) / 2);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = avatar.player.id;
      }
    }
    return nearest;
  }

  private setTarget(id: string | null): void {
    if (id === this.targetId) return;

    if (this.targetId) this.avatars.get(this.targetId)?.setHighlighted(false);
    this.targetId = id;

    const avatar = id ? this.avatars.get(id) : undefined;
    avatar?.setHighlighted(true);
    this.onTarget?.(avatar?.player ?? null);
  }

  private handleResize = (): void => {
    const { innerWidth: w, innerHeight: h } = window;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  private buildRoom(): void {
    // A box turned inside out is the cheapest way to be inside a room.
    const shell = new THREE.Mesh(
      new THREE.BoxGeometry(ROOM_SIZE, ROOM_HEIGHT, ROOM_SIZE),
      new THREE.MeshStandardMaterial({
        color: 0x2b3040,
        roughness: 0.95,
        side: THREE.BackSide,
      }),
    );
    shell.position.y = ROOM_HEIGHT / 2;
    this.scene.add(shell);

    const rug = new THREE.Mesh(
      new THREE.CircleGeometry(SEAT_RADIUS + 1.1, 48),
      new THREE.MeshStandardMaterial({ color: 0x39405a, roughness: 1 }),
    );
    rug.rotation.x = -Math.PI / 2;
    rug.position.y = 0.01;
    this.scene.add(rug);

    this.scene.add(new THREE.HemisphereLight(0xdfe7ff, 0x2b2f3c, 1.1));

    const lamp = new THREE.PointLight(0xffe4b0, 42, 16, 2);
    lamp.position.set(0, ROOM_HEIGHT - 0.7, 0);
    this.scene.add(lamp);

    // A visible bulb, so the light in the room has a source you can look at.
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.11, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffe9c4 }),
    );
    bulb.position.copy(lamp.position);
    this.scene.add(bulb);
  }

  private buildTable(): void {
    const wood = new THREE.MeshStandardMaterial({
      color: 0x8a5a3b,
      roughness: 0.6,
    });

    const top = new THREE.Mesh(
      new THREE.CylinderGeometry(TABLE_RADIUS, TABLE_RADIUS, 0.08, 48),
      wood,
    );
    top.position.y = TABLE_HEIGHT;

    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.14, 0.2, TABLE_HEIGHT, 20),
      wood,
    );
    stem.position.y = TABLE_HEIGHT / 2;

    const foot = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.55, 0.06, 28),
      wood,
    );
    foot.position.y = 0.03;

    this.scene.add(top, stem, foot);
  }

  /** An empty chair at every seat, so unfilled slots still read as a party. */
  private buildChairs(): void {
    const material = new THREE.MeshStandardMaterial({
      color: 0x4a5168,
      roughness: 0.8,
    });
    const seatGeo = new THREE.BoxGeometry(0.5, 0.08, 0.5);
    const backGeo = new THREE.BoxGeometry(0.5, 0.55, 0.07);

    for (let i = 0; i < MAX_SEATS; i++) {
      const chair = new THREE.Group();
      chair.position.copy(seatPosition(i));
      chair.rotation.y = seatFacing(i);

      const pad = new THREE.Mesh(seatGeo, material);
      pad.position.y = 0.45;

      const back = new THREE.Mesh(backGeo, material);
      back.position.set(0, 0.74, 0.26);

      chair.add(pad, back);
      this.scene.add(chair);
    }
  }
}
