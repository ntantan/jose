import {
  isValidCode,
  MAX_SEATS,
  SPEECH_MS,
  type Player,
  type RoomSummary,
} from "../shared/protocol";
import type { PickerState } from "./actionPicker";

/** How many actions show on each side of the selected one in the menu. */
const MENU_NEIGHBOURS = 2;

/** Long enough to read a sentence while already looking for your next target. */
const ANNOUNCE_MS = 3500;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

function colorCss(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

/** The DOM overlay: lobby, room HUD, and the pointer-lock hint. */
export class Ui {
  private readonly lobby = el<HTMLDivElement>("lobby");
  private readonly nameInput = el<HTMLInputElement>("name");
  private readonly createButton = el<HTMLButtonElement>("create");
  private readonly joinForm = el<HTMLFormElement>("join-form");
  private readonly codeInput = el<HTMLInputElement>("code");
  private readonly roomList = el<HTMLUListElement>("rooms");
  private readonly noRooms = el<HTMLParagraphElement>("no-rooms");
  private readonly errorText = el<HTMLParagraphElement>("error");
  private readonly hud = el<HTMLDivElement>("hud");
  private readonly hudCode = el<HTMLElement>("hud-code");
  private readonly playerList = el<HTMLUListElement>("players");
  private readonly leaveButton = el<HTMLButtonElement>("leave");
  private readonly hint = el<HTMLDivElement>("hint");
  private readonly crosshair = el<HTMLDivElement>("crosshair");
  private readonly actions = el<HTMLDivElement>("actions");
  private readonly actionTarget = el<HTMLElement>("action-target");
  private readonly actionsHint = el<HTMLElement>("actions-hint");
  private readonly actionList = el<HTMLUListElement>("action-list");
  private readonly said = el<HTMLParagraphElement>("said");
  private readonly announcement = el<HTMLParagraphElement>("announce");

  private saidTimer?: number;
  private announceTimer?: number;
  private busy = false;
  private readonly onJoin: (code: string, name: string) => void;

  constructor(actions: {
    onCreate: (name: string) => void;
    onJoin: (code: string, name: string) => void;
    onLeave: () => void;
  }) {
    this.onJoin = actions.onJoin;

    this.createButton.addEventListener("click", () => {
      this.clearError();
      actions.onCreate(this.name);
    });

    this.joinForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const code = this.codeInput.value.trim().toUpperCase();
      if (!isValidCode(code)) {
        this.showError("Room codes are 4 letters or numbers.");
        return;
      }
      this.clearError();
      actions.onJoin(code, this.name);
    });

    this.leaveButton.addEventListener("click", () => actions.onLeave());

    // Codes are shown uppercase, so type them that way too.
    this.codeInput.addEventListener("input", () => {
      this.codeInput.value = this.codeInput.value.toUpperCase();
    });
  }

  private get name(): string {
    return this.nameInput.value.trim() || "Player";
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.createButton.disabled = busy;
    this.joinForm.querySelector("button")!.disabled = busy;
    for (const button of this.roomList.querySelectorAll("button")) {
      button.disabled = busy || button.dataset.full === "true";
    }
  }

  /** The lobby's list of open rooms, each joinable in one click. */
  renderRooms(rooms: RoomSummary[]): void {
    const rows = rooms.map((room) => {
      const row = document.createElement("li");

      const code = document.createElement("strong");
      code.className = "room-code";
      code.textContent = room.code;

      const who = document.createElement("span");
      who.className = "room-names";
      who.textContent = room.names.join(", ") || "Empty";

      const count = document.createElement("span");
      count.className = "room-count";
      count.textContent = `${room.names.length}/${MAX_SEATS}`;

      const full = room.names.length >= MAX_SEATS;
      const join = document.createElement("button");
      join.textContent = full ? "Full" : "Join";
      join.dataset.full = String(full);
      join.disabled = this.busy || full;
      join.addEventListener("click", () => {
        this.clearError();
        this.onJoin(room.code, this.name);
      });

      row.append(code, who, count, join);
      return row;
    });

    this.roomList.replaceChildren(...rows);
    this.noRooms.hidden = rooms.length > 0;
  }

  showError(message: string): void {
    this.errorText.textContent = message;
    this.errorText.hidden = false;
  }

  clearError(): void {
    this.errorText.hidden = true;
  }

  enterRoom(code: string): void {
    this.lobby.hidden = true;
    this.hud.hidden = false;
    this.hudCode.textContent = code;
    this.setBusy(false);
  }

  leaveRoom(): void {
    this.lobby.hidden = false;
    this.hud.hidden = true;
    this.hint.hidden = true;
    this.playerList.replaceChildren();
    this.hideActionMenu();
    this.setCrosshairVisible(false);
    this.clearSaid();
    this.clearAnnouncement();
    this.setBusy(false);
  }

  setHintVisible(visible: boolean): void {
    this.hint.hidden = !visible;
  }

  setCrosshairVisible(visible: boolean): void {
    this.crosshair.hidden = !visible;
  }

  /**
   * Closed: a tag under the crosshair naming the aimed-at player. Open: the
   * actions as a carousel around the selected one, still naming the target
   * since aiming goes on while choosing.
   */
  showActionMenu(state: PickerState): void {
    if (!state.open && !state.target) {
      this.hideActionMenu();
      return;
    }

    this.actionTarget.textContent = state.target?.name ?? "Aim at someone";
    this.actionTarget.classList.toggle("none", !state.target);
    this.actionList.hidden = !state.open;
    this.actionsHint.textContent = state.open
      ? "A / D to choose · click or Space to say · right click to go back"
      : "Click or Space for actions";
    this.actions.hidden = false;
    if (!state.open) return;

    // Wraps around, but never shows the same entry twice in a short list.
    const count = state.labels.length;
    const reach = Math.min(MENU_NEIGHBOURS, Math.floor((count - 1) / 2));
    const rows: HTMLLIElement[] = [];
    for (let offset = -reach; offset <= reach; offset++) {
      const row = document.createElement("li");
      row.textContent = state.labels[(state.selected + offset + count) % count]!;
      if (offset === 0) row.className = "selected";
      else if (Math.abs(offset) === reach && reach > 1) row.className = "far";
      rows.push(row);
    }
    this.actionList.replaceChildren(...rows);
  }

  hideActionMenu(): void {
    this.actions.hidden = true;
  }

  /**
   * The last action said in the room, whoever said it to whoever. The 3D
   * bubble only helps if the speaker is in view; this reaches everyone, and
   * stands out when the words were aimed at you.
   */
  flashSaid(from: Player, text: string, atYou: boolean): void {
    this.clearSaid();

    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = colorCss(from.color);

    this.said.replaceChildren(dot, text);
    this.said.classList.toggle("at-you", atYou);
    this.said.hidden = false;
    this.saidTimer = window.setTimeout(() => this.clearSaid(), SPEECH_MS);
  }

  private clearSaid(): void {
    if (this.saidTimer !== undefined) clearTimeout(this.saidTimer);
    this.saidTimer = undefined;
    this.said.hidden = true;
  }

  /** A game event everyone should notice, e.g. who starts the round. */
  announce(text: string): void {
    this.clearAnnouncement();
    this.announcement.textContent = text;
    this.announcement.hidden = false;
    this.announceTimer = window.setTimeout(
      () => this.clearAnnouncement(),
      ANNOUNCE_MS,
    );
  }

  private clearAnnouncement(): void {
    if (this.announceTimer !== undefined) clearTimeout(this.announceTimer);
    this.announceTimer = undefined;
    this.announcement.hidden = true;
  }

  /** Rebuilt wholesale: the roster is at most 8 rows. */
  renderPlayers(players: Player[], youId: string): void {
    const rows = [...players]
      .sort((a, b) => a.seat - b.seat)
      .map((player) => {
        const row = document.createElement("li");

        const dot = document.createElement("span");
        dot.className = "dot";
        dot.style.background = colorCss(player.color);

        const label = document.createElement("span");
        label.textContent = player.name;

        row.append(dot, label);

        if (player.id === youId) {
          const you = document.createElement("span");
          you.className = "you";
          you.textContent = "(you)";
          row.append(you);
        }

        const losses = document.createElement("span");
        losses.className = "losses";
        losses.title = "Losses";
        losses.textContent = `✕ ${player.losses}`;
        row.append(losses);
        return row;
      });

    this.playerList.replaceChildren(...rows);
  }
}
