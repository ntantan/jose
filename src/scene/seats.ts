import * as THREE from "three";
import { MAX_SEATS } from "../../shared/protocol";

/** Distance from the table centre to each seat. */
export const SEAT_RADIUS = 2.4;

/** Eye height of a seated player, metres above the floor. */
export const EYE_HEIGHT = 1.2;

/**
 * Seat geometry is defined once here and read by both the local camera and the
 * remote avatars, so your own view and everyone else's view of you agree by
 * construction rather than by two hand-matched constants.
 */
export function seatPosition(seat: number): THREE.Vector3 {
  const theta = (seat / MAX_SEATS) * Math.PI * 2;
  return new THREE.Vector3(
    Math.sin(theta) * SEAT_RADIUS,
    0,
    Math.cos(theta) * SEAT_RADIUS,
  );
}

/**
 * Yaw that points a seat inward, toward the table.
 *
 * A three.js camera with `rotation.y = t` looks along `(-sin t, 0, -cos t)`.
 * Facing the origin from `p` therefore needs `atan2(p.x, p.z)` -- which works
 * out to the seat's own angle around the ring.
 */
export function seatFacing(seat: number): number {
  const p = seatPosition(seat);
  return Math.atan2(p.x, p.z);
}

/** Where the eyes of a seated player sit. */
export function seatEye(seat: number): THREE.Vector3 {
  return seatPosition(seat).setY(EYE_HEIGHT);
}
