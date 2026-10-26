import * as THREE from "three";

const GRAVITY = 9.8;
/** How long the landing squash takes to settle, seconds. */
const SQUASH_S = 0.3;

// Shared by every poop and never disposed: there are only ever a handful.
const material = new THREE.MeshStandardMaterial({
  color: 0x6b4423,
  roughness: 0.55,
});
const coils = [
  { radius: 0.1, tube: 0.05, y: 0.05 },
  { radius: 0.07, tube: 0.045, y: 0.12 },
  { radius: 0.04, tube: 0.038, y: 0.18 },
].map(({ radius, tube, y }) => ({
  geometry: new THREE.TorusGeometry(radius, tube, 10, 20),
  y,
}));
const tipGeometry = new THREE.ConeGeometry(0.04, 0.08, 12);

/**
 * The loser's prize: a stack of coils that drops from above and lands with a
 * squash. It stays until removed -- the loser wears it until they play.
 */
export class Poop {
  readonly group = new THREE.Group();

  private readonly restY: number;
  private velocity = 0;
  private landedFor = -1;

  /** `restY` is where it lands, in the parent's frame; it starts `drop` above. */
  constructor(restY: number, drop: number) {
    this.restY = restY;
    this.group.position.y = restY + drop;

    for (const coil of coils) {
      const mesh = new THREE.Mesh(coil.geometry, material);
      mesh.rotation.x = Math.PI / 2;
      mesh.position.y = coil.y;
      this.group.add(mesh);
    }
    const tip = new THREE.Mesh(tipGeometry, material);
    tip.position.y = 0.24;
    this.group.add(tip);
  }

  /** Advance by `dt` seconds. */
  update(dt: number): void {
    if (this.landedFor < 0) {
      this.velocity += GRAVITY * dt;
      this.group.position.y -= this.velocity * dt;
      if (this.group.position.y <= this.restY) {
        this.group.position.y = this.restY;
        this.landedFor = 0;
      }
      return;
    }

    if (this.landedFor > SQUASH_S) return;
    this.landedFor += dt;
    const squash = Math.max(0, 1 - this.landedFor / SQUASH_S);
    this.group.scale.set(1 + 0.35 * squash, 1 - 0.45 * squash, 1 + 0.35 * squash);
  }
}
