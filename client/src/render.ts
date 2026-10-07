import { ARENA_HEIGHT, ARENA_WIDTH, TANK_RADIUS } from "@tanks/shared";

export interface DrawTank {
  id: number;
  name: string;
  x: number;
  y: number;
  angle: number;
  self: boolean;
}

function colorFor(id: number): string {
  const hue = (id * 137.508) % 360; // golden-angle spread
  return `hsl(${hue.toFixed(0)} 70% 60%)`;
}

/** Plain Canvas 2D renderer. Draws in world units; the canvas is sized to the arena. */
export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = ARENA_WIDTH * dpr;
    canvas.height = ARENA_HEIGHT * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D not supported");
    ctx.scale(dpr, dpr);
    this.ctx = ctx;
  }

  draw(tanks: readonly DrawTank[]): void {
    const { ctx } = this;
    ctx.clearRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);

    ctx.strokeStyle = "#1c2330";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= ARENA_WIDTH; x += 50) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, ARENA_HEIGHT);
    }
    for (let y = 0; y <= ARENA_HEIGHT; y += 50) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(ARENA_WIDTH, y + 0.5);
    }
    ctx.stroke();

    for (const t of tanks) this.drawTank(t);
  }

  private drawTank(t: DrawTank): void {
    const { ctx } = this;
    const color = colorFor(t.id);
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.rotate(t.angle);
    ctx.fillStyle = color;
    ctx.fillRect(-TANK_RADIUS, -TANK_RADIUS * 0.8, TANK_RADIUS * 2, TANK_RADIUS * 1.6);
    ctx.fillStyle = "#0c0f14";
    ctx.fillRect(0, -3, TANK_RADIUS * 1.4, 6);
    if (t.self) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.strokeRect(-TANK_RADIUS, -TANK_RADIUS * 0.8, TANK_RADIUS * 2, TANK_RADIUS * 1.6);
    }
    ctx.restore();

    ctx.fillStyle = "#cfd6e2";
    ctx.font = "12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(t.self ? `${t.name} (you)` : t.name, t.x, t.y - TANK_RADIUS - 8);
  }
}
