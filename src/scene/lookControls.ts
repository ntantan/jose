import * as THREE from "three";
import { MAX_PITCH } from "../../shared/protocol";

const SENSITIVITY = 0.0022;

/**
 * Pointer-lock mouse-look, hand-rolled rather than three's PointerLockControls
 * because the yaw/pitch have to go on the wire as plain numbers anyway. The
 * camera's position is set once from the seat and never touched: this
 * prototype has no movement at all.
 */
export class LookControls {
  yaw = 0;
  pitch = 0;

  private readonly canvas: HTMLCanvasElement;
  private readonly camera: THREE.PerspectiveCamera;
  private enabled = false;
  private onLockChange?: (locked: boolean) => void;

  constructor(camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement) {
    this.camera = camera;
    this.canvas = canvas;
    this.camera.rotation.order = "YXZ";

    canvas.addEventListener("click", this.requestLock);
    document.addEventListener("pointerlockchange", this.handleLockChange);
    document.addEventListener("mousemove", this.handleMouseMove);
  }

  /** Enabled between joining and leaving a room. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled && this.isLocked) document.exitPointerLock();
  }

  /** Face the middle of the room from a given seat. */
  reset(yaw: number): void {
    this.yaw = yaw;
    this.pitch = 0;
    this.apply();
  }

  onLock(handler: (locked: boolean) => void): void {
    this.onLockChange = handler;
  }

  get isLocked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  dispose(): void {
    this.canvas.removeEventListener("click", this.requestLock);
    document.removeEventListener("pointerlockchange", this.handleLockChange);
    document.removeEventListener("mousemove", this.handleMouseMove);
  }

  private requestLock = (): void => {
    if (this.enabled && !this.isLocked) void this.canvas.requestPointerLock();
  };

  private handleLockChange = (): void => {
    this.onLockChange?.(this.isLocked);
  };

  private handleMouseMove = (event: MouseEvent): void => {
    if (!this.enabled || !this.isLocked) return;
    this.yaw -= event.movementX * SENSITIVITY;
    this.pitch -= event.movementY * SENSITIVITY;
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch));
    this.apply();
  };

  private apply(): void {
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }
}
