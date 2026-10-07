import { ARENA_HEIGHT, ARENA_WIDTH, Key, setKey } from "@tanks/shared";

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

/** Tracks held keys (and the mouse button, as Fire) as the shared bitmask. */
export class Keyboard {
  private held = 0;
  private mouseFire = false;

  constructor(target: Window = window) {
    target.addEventListener("keydown", (e) => this.onKey(e, true));
    target.addEventListener("keyup", (e) => this.onKey(e, false));
    // Avoid stuck keys when the tab loses focus mid-press.
    target.addEventListener("blur", () => {
      this.held = 0;
      this.mouseFire = false;
    });
  }

  get keys(): number {
    return this.mouseFire ? this.held | Key.Fire : this.held;
  }

  setMouseFire(down: boolean): void {
    this.mouseFire = down;
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const bit = BINDINGS[e.code];
    if (bit === undefined) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    e.preventDefault();
    this.held = setKey(this.held, bit, down);
  }
}

/** Mouse position in world coordinates (the canvas is scaled with CSS). */
export class Mouse {
  x: number | null = null;
  y: number | null = null;

  constructor(canvas: HTMLCanvasElement, keyboard: Keyboard) {
    canvas.addEventListener("mousemove", (e) => {
      const r = canvas.getBoundingClientRect();
      this.x = ((e.clientX - r.left) * ARENA_WIDTH) / r.width;
      this.y = ((e.clientY - r.top) * ARENA_HEIGHT) / r.height;
    });
    canvas.addEventListener("mousedown", (e) => {
      if (e.button === 0) keyboard.setMouseFire(true);
    });
    window.addEventListener("mouseup", () => keyboard.setMouseFire(false));
  }

  /** Aim angle from (x, y), or `fallback` before the mouse has moved. */
  aimFrom(x: number, y: number, fallback: number): number {
    if (this.x === null || this.y === null) return fallback;
    return Math.atan2(this.y - y, this.x - x);
  }
}
