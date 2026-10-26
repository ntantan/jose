import { ACTIONS, type Player, type Say } from "../shared/protocol";

/** What the UI needs to draw the picker. */
export interface PickerState {
  target: Player | null;
  open: boolean;
  labels: string[];
  selected: number;
}

/**
 * Aim-and-say. The mouse only aims: the world says who is under the crosshair.
 * Click or Space opens the action menu, A/D cycle through the ACTIONS, and
 * click or Space says the selected one to whoever is aimed at by then. Right
 * click or Esc goes back: out of the "Number…" list (1..player count), or out
 * of the menu. No scroll wheel needed, so a trackpad is enough.
 *
 * The click listener is safe to share the canvas with the pointer-lock one:
 * `requestPointerLock` resolves asynchronously, so on the click that captures
 * the mouse we are still unlocked here and nothing opens by accident.
 */
export class ActionPicker {
  private readonly canvas: HTMLCanvasElement;
  private readonly isLocked: () => boolean;
  private readonly playerCount: () => number;

  private target: Player | null = null;
  private open = false;
  /** True while the numbers list is showing. */
  private numbers = false;
  private index = 0;
  /** Where the main list was left, so the next open starts there. */
  private lastAction = 0;
  private onChanged?: (state: PickerState) => void;
  private onConfirmed?: (target: Player, say: Say) => void;

  constructor(
    canvas: HTMLCanvasElement,
    isLocked: () => boolean,
    playerCount: () => number,
  ) {
    this.canvas = canvas;
    this.isLocked = isLocked;
    this.playerCount = playerCount;

    canvas.addEventListener("click", this.handleClick);
    canvas.addEventListener("mousedown", this.handleMouseDown);
    canvas.addEventListener("contextmenu", this.handleContextMenu);
    document.addEventListener("keydown", this.handleKey);
  }

  /**
   * Called by the world when the aimed-at player changes. The menu stays open
   * meanwhile: you can pick the action first and the person second.
   */
  setTarget(target: Player | null): void {
    if (target?.id === this.target?.id) return;
    this.target = target;
    this.emit();
  }

  /** Called when the mouse is released (Esc included). */
  close(): void {
    if (!this.open) return;
    this.open = false;
    this.numbers = false;
    this.emit();
  }

  onChange(handler: (state: PickerState) => void): void {
    this.onChanged = handler;
  }

  onConfirm(handler: (target: Player, say: Say) => void): void {
    this.onConfirmed = handler;
  }

  dispose(): void {
    this.canvas.removeEventListener("click", this.handleClick);
    this.canvas.removeEventListener("mousedown", this.handleMouseDown);
    this.canvas.removeEventListener("contextmenu", this.handleContextMenu);
    document.removeEventListener("keydown", this.handleKey);
  }

  /** The lines of whichever list is showing. */
  private get labels(): string[] {
    if (!this.numbers) return ACTIONS.map((action) => action.label);
    return Array.from({ length: this.playerCount() }, (_, i) => String(i + 1));
  }

  private emit(): void {
    // Someone may have left while the numbers were open.
    this.index = Math.min(this.index, this.labels.length - 1);
    this.onChanged?.({
      target: this.target,
      open: this.open,
      labels: this.labels,
      selected: this.index,
    });
  }

  /** Click and Space: open the menu, or say what is selected. */
  private activate(): void {
    if (!this.open) {
      if (!this.target) return;
      this.open = true;
      this.index = this.lastAction;
      this.emit();
      return;
    }
    this.confirm();
  }

  /** Right click and Esc: leave the numbers, or leave the menu. */
  private back(): void {
    if (!this.numbers) {
      this.close();
      return;
    }
    this.numbers = false;
    this.index = this.lastAction;
    this.emit();
  }

  private step(by: number): void {
    const count = this.labels.length;
    this.index = (this.index + by + count) % count;
    this.emit();
  }

  private confirm(): void {
    // Aiming at nobody: keep the menu as it is until someone is under the crosshair.
    if (!this.target) return;

    if (this.numbers) {
      this.say({ action: "number", n: this.index + 1 });
      return;
    }

    this.lastAction = this.index;
    const action = ACTIONS[this.index]!.id;
    if (action === "number") {
      this.numbers = true;
      this.index = 0;
      this.emit();
      return;
    }
    this.say({ action });
  }

  private say(say: Say): void {
    const target = this.target!;
    this.close();
    this.onConfirmed?.(target, say);
  }

  private handleClick = (event: MouseEvent): void => {
    if (event.button !== 0 || !this.isLocked()) return;
    this.activate();
  };

  private handleMouseDown = (event: MouseEvent): void => {
    if (event.button !== 2 || !this.isLocked()) return;
    this.back();
  };

  private handleContextMenu = (event: MouseEvent): void => {
    // Right click is "back"; the browser menu would also release the mouse.
    event.preventDefault();
  };

  private handleKey = (event: KeyboardEvent): void => {
    if (!this.isLocked() || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }

    switch (event.key.toLowerCase()) {
      case " ":
        if (!event.repeat) this.activate();
        break;
      case "a":
      case "arrowleft":
        if (!this.open) return;
        this.step(-1);
        break;
      case "d":
      case "arrowright":
        if (!this.open) return;
        this.step(1);
        break;
      case "escape":
        // Browsers usually release the mouse on Esc too, which closes the
        // menu through close() anyway.
        this.back();
        break;
      default:
        return;
    }
    event.preventDefault();
  };
}
