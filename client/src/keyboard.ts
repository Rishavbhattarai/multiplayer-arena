import { Key, setKey } from "@tanks/shared";

const BINDINGS: Record<string, number> = {
  KeyW: Key.Up,
  ArrowUp: Key.Up,
  KeyS: Key.Down,
  ArrowDown: Key.Down,
  KeyA: Key.Left,
  ArrowLeft: Key.Left,
  KeyD: Key.Right,
  ArrowRight: Key.Right,
  Space: Key.Fire,
};

/** Tracks held keys as the shared bitmask. */
export class Keyboard {
  keys = 0;

  constructor(target: Window = window) {
    target.addEventListener("keydown", (e) => this.onKey(e, true));
    target.addEventListener("keyup", (e) => this.onKey(e, false));
    // Avoid stuck keys when the tab loses focus mid-press.
    target.addEventListener("blur", () => (this.keys = 0));
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const bit = BINDINGS[e.code];
    if (bit === undefined) return;
    if (e.target instanceof HTMLInputElement) return;
    e.preventDefault();
    this.keys = setKey(this.keys, bit, down);
  }
}
