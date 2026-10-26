import * as THREE from "three";
import { SPEECH_MS, type Player } from "../../shared/protocol";
import { EYE_HEIGHT, seatFacing, seatPosition } from "./seats";

const HEAD_RADIUS = 0.19;
const BODY_HEIGHT = 0.62;

/** Top of the head in the avatar's frame, for things that land on it. */
export const HEAD_TOP = EYE_HEIGHT + HEAD_RADIUS;

/** Label styling: the nameplate is quiet, spoken words are not. */
type LabelStyle = { background: string; color: string; height: number };

const NAMEPLATE: LabelStyle = {
  background: "rgba(20, 22, 29, 0.78)",
  color: "#eef1f6",
  height: 0.24,
};

const SPEECH: LabelStyle = {
  background: "rgba(238, 241, 246, 0.94)",
  color: "#14161d",
  height: 0.3,
};

/** Words aimed at you stand out from words aimed at somebody else. */
const SPEECH_AT_YOU: LabelStyle = {
  background: "rgba(242, 177, 52, 0.95)",
  color: "#1a1405",
  height: 0.3,
};

/**
 * Another player, seated. The seat sets the base facing; the network yaw/pitch
 * is applied to the head group only, on top of that base, so someone turning
 * to look at you reads correctly from every other seat in the ring.
 */
export class Avatar {
  readonly group = new THREE.Group();
  readonly player: Player;

  private readonly head = new THREE.Group();
  private readonly skin: THREE.MeshStandardMaterial;
  private readonly disposables: { dispose(): void }[] = [];

  private speech?: THREE.Sprite;
  private speechTimer?: number;

  constructor(player: Player) {
    this.player = player;

    const seated = seatPosition(player.seat);
    this.group.position.copy(seated);
    this.group.rotation.y = seatFacing(player.seat);

    const skin = new THREE.MeshStandardMaterial({
      color: player.color,
      roughness: 0.65,
      metalness: 0.05,
      emissive: 0x000000,
      emissiveIntensity: 0,
    });
    this.skin = skin;
    this.disposables.push(skin);

    const bodyGeo = new THREE.CapsuleGeometry(0.24, BODY_HEIGHT, 6, 14);
    const body = new THREE.Mesh(bodyGeo, skin);
    body.position.y = BODY_HEIGHT / 2 + 0.24;
    this.disposables.push(bodyGeo);
    this.group.add(body);

    const headGeo = new THREE.SphereGeometry(HEAD_RADIUS, 22, 16);
    const headMesh = new THREE.Mesh(headGeo, skin);
    this.disposables.push(headGeo);

    // A nose, so which way a head is turned is legible at a glance.
    const noseGeo = new THREE.ConeGeometry(0.05, 0.13, 10);
    const nose = new THREE.Mesh(noseGeo, skin);
    nose.position.set(0, 0, -HEAD_RADIUS);
    nose.rotation.x = -Math.PI / 2;
    this.disposables.push(noseGeo);

    this.head.position.y = EYE_HEIGHT;
    this.head.add(headMesh, nose, ...this.makeEyes());
    this.group.add(this.head);

    const plate = this.makeLabel(player.name, NAMEPLATE);
    plate.position.y = EYE_HEIGHT + 0.52;
    this.disposables.push(plate.material, plate.material.map!);
    this.group.add(plate);
  }

  /** Angles arrive in the local player's frame; the seat's facing is the base. */
  setLook(yaw: number, pitch: number): void {
    this.head.rotation.order = "YXZ";
    this.head.rotation.y = yaw - seatFacing(this.player.seat);
    this.head.rotation.x = pitch;
  }

  /**
   * Selection is shown by lighting the avatar up in its own colour: one shared
   * material covers body, head and nose, so this glows the whole of them.
   */
  setHighlighted(highlighted: boolean): void {
    this.skin.emissive.setHex(highlighted ? this.player.color : 0x000000);
    this.skin.emissiveIntensity = highlighted ? 0.55 : 0;
  }

  /** Where to aim at: the head, which is what you actually look for. */
  headPosition(): THREE.Vector3 {
    return this.head.getWorldPosition(new THREE.Vector3());
  }

  /** Show a word above this player for a moment, replacing any current one. */
  say(text: string, atYou: boolean): void {
    this.clearSpeech();

    const bubble = this.makeLabel(text, atYou ? SPEECH_AT_YOU : SPEECH);
    bubble.position.y = EYE_HEIGHT + 0.88;
    this.group.add(bubble);

    this.speech = bubble;
    this.speechTimer = window.setTimeout(() => this.clearSpeech(), SPEECH_MS);
  }

  dispose(): void {
    this.clearSpeech();
    this.group.removeFromParent();
    for (const item of this.disposables) item.dispose();
  }

  /**
   * Two eyes above the nose, sitting on the head's surface. They have their
   * own materials, so a highlighted avatar glows but its eyes stay readable.
   */
  private makeEyes(): THREE.Object3D[] {
    const whiteGeo = new THREE.SphereGeometry(0.045, 14, 10);
    const pupilGeo = new THREE.SphereGeometry(0.022, 10, 8);
    const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
    const pupil = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.2 });
    this.disposables.push(whiteGeo, pupilGeo, white, pupil);

    return [-1, 1].map((side) => {
      const eye = new THREE.Group();
      // Point on the sphere, a little up and to the side of the -Z face.
      const dir = new THREE.Vector3(side * 0.42, 0.32, -1).normalize();
      eye.position.copy(dir).multiplyScalar(HEAD_RADIUS * 0.93);
      eye.lookAt(dir.clone().multiplyScalar(2));

      const ball = new THREE.Mesh(whiteGeo, white);
      const iris = new THREE.Mesh(pupilGeo, pupil);
      // Group's +Z faces outward after lookAt.
      iris.position.z = 0.032;
      eye.add(ball, iris);
      return eye;
    });
  }

  private clearSpeech(): void {
    if (this.speechTimer !== undefined) clearTimeout(this.speechTimer);
    this.speechTimer = undefined;

    if (!this.speech) return;
    this.speech.removeFromParent();
    this.speech.material.map?.dispose();
    this.speech.material.dispose();
    this.speech = undefined;
  }

  /** A rounded pill of text as a camera-facing sprite. */
  private makeLabel(text: string, style: LabelStyle): THREE.Sprite {
    const scale = 2;
    const font = 44 * scale;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;

    ctx.font = `600 ${font}px system-ui, sans-serif`;
    const padding = 22 * scale;
    canvas.width = Math.ceil(ctx.measureText(text).width) + padding * 2;
    canvas.height = font + padding * 2;

    // Resizing the canvas resets the context, so restate the font.
    ctx.font = `600 ${font}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = style.background;
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, 26 * scale);
    ctx.fill();
    ctx.fillStyle = style.color;
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.SpriteMaterial({
      map: texture,
      depthTest: false,
      transparent: true,
    });

    const sprite = new THREE.Sprite(material);
    // World-sized, so it shrinks with distance; big enough to stay readable
    // from the far side of the table.
    sprite.scale.set(
      (canvas.width / canvas.height) * style.height,
      style.height,
      1,
    );
    // Draw over the geometry so a label is never buried in the table.
    sprite.renderOrder = 10;
    return sprite;
  }
}
