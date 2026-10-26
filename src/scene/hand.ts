import * as THREE from "three";

/** How long the flick takes, seconds. */
const TRAVEL_S = 0.35;
/** How long it holds the end pose before vanishing, seconds. */
const LINGER_S = 0.4;

// Shared by every hand and never disposed: one is alive at a time, at most a few.
const skin = new THREE.MeshStandardMaterial({ color: 0xf1c27d, roughness: 0.7 });
const palmGeometry = new THREE.BoxGeometry(0.16, 0.045, 0.16);
const fingerGeometry = new THREE.BoxGeometry(0.032, 0.035, 0.11);
const thumbGeometry = new THREE.BoxGeometry(0.035, 0.035, 0.08);

/**
 * A flat hand that sweeps from one point to another along an arc, fingers
 * leading, then disappears -- the slurp gesture.
 */
export class Hand {
  readonly group = new THREE.Group();

  private readonly curve: THREE.QuadraticBezierCurve3;
  private age = 0;

  /** `lift` is how far above the straight line the arc peaks. */
  constructor(from: THREE.Vector3, to: THREE.Vector3, lift: number) {
    const mid = from.clone().lerp(to, 0.5);
    mid.y += lift * 2; // A quadratic Bézier peaks at half its control height.
    this.curve = new THREE.QuadraticBezierCurve3(from, mid, to);

    const palm = new THREE.Mesh(palmGeometry, skin);
    this.group.add(palm);
    // Built along +Z, which is where lookAt points an Object3D.
    for (let i = 0; i < 4; i++) {
      const finger = new THREE.Mesh(fingerGeometry, skin);
      finger.position.set(-0.06 + i * 0.04, 0, 0.13);
      this.group.add(finger);
    }
    const thumb = new THREE.Mesh(thumbGeometry, skin);
    thumb.position.set(0.095, 0, 0.02);
    thumb.rotation.y = -0.6;
    this.group.add(thumb);

    this.place(0);
  }

  /** Advance by `dt` seconds. Returns false once it is done and removed. */
  update(dt: number): boolean {
    this.age += dt;
    if (this.age >= TRAVEL_S + LINGER_S) {
      this.group.removeFromParent();
      return false;
    }
    const t = Math.min(this.age / TRAVEL_S, 1);
    // Ease in and out, so it reads as a throw rather than a conveyor belt.
    this.place(t * t * (3 - 2 * t));
    return true;
  }

  private place(t: number): void {
    this.group.position.copy(this.curve.getPoint(t));
    const ahead = this.curve.getTangent(Math.min(t, 0.999));
    this.group.lookAt(this.group.position.clone().add(ahead));
  }
}
