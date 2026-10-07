import { ARENA_HEIGHT, ARENA_WIDTH, TANK_MAX_HP, TANK_RADIUS } from "@tanks/shared";

export interface DrawTank {
  id: number;
  name: string;
  x: number;
  y: number;
  angle: number;
  aim: number;
  hp: number;
  score: number;
  dc: boolean;
  self: boolean;
}

export interface Tracer {
  x: number;
  y: number;
  a: number;
  len: number;
  bornAt: number;
  hit: boolean;
}

export interface Scene {
  tanks: DrawTank[];
  tracers: Tracer[];
  now: number;
  /** Faint outline of where the server last said our tank was (authoritative mode). */
  serverGhost?: { x: number; y: number; angle: number } | undefined;
  banner?: string | undefined;
}

const TRACER_MS = 180;

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

  draw(scene: Scene): void {
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

    if (scene.serverGhost) {
      const g = scene.serverGhost;
      ctx.save();
      ctx.translate(g.x, g.y);
      ctx.rotate(g.angle);
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(-TANK_RADIUS, -TANK_RADIUS * 0.8, TANK_RADIUS * 2, TANK_RADIUS * 1.6);
      ctx.restore();
    }

    for (const t of scene.tanks) this.drawTank(t);

    for (const tr of scene.tracers) {
      const age = scene.now - tr.bornAt;
      if (age > TRACER_MS) continue;
      ctx.globalAlpha = 1 - age / TRACER_MS;
      ctx.strokeStyle = tr.hit ? "#ff6b6b" : "#ffe08a";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(tr.x, tr.y);
      ctx.lineTo(tr.x + Math.cos(tr.a) * tr.len, tr.y + Math.sin(tr.a) * tr.len);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    this.drawScoreboard(scene.tanks);

    if (scene.banner) {
      ctx.fillStyle = "rgba(12,15,20,0.75)";
      ctx.fillRect(0, ARENA_HEIGHT / 2 - 30, ARENA_WIDTH, 60);
      ctx.fillStyle = "#e6e9ef";
      ctx.font = "20px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(scene.banner, ARENA_WIDTH / 2, ARENA_HEIGHT / 2 + 7);
    }
  }

  private drawTank(t: DrawTank): void {
    const { ctx } = this;
    const dead = t.hp <= 0;
    ctx.globalAlpha = t.dc ? 0.35 : dead ? 0.25 : 1;
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.rotate(t.angle);
    ctx.fillStyle = colorFor(t.id);
    ctx.fillRect(-TANK_RADIUS, -TANK_RADIUS * 0.8, TANK_RADIUS * 2, TANK_RADIUS * 1.6);
    if (t.self) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.strokeRect(-TANK_RADIUS, -TANK_RADIUS * 0.8, TANK_RADIUS * 2, TANK_RADIUS * 1.6);
    }
    ctx.restore();

    // Turret
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.rotate(t.aim);
    ctx.fillStyle = "#0c0f14";
    ctx.beginPath();
    ctx.arc(0, 0, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(0, -3, TANK_RADIUS * 1.5, 6);
    ctx.restore();

    // HP bar
    const w = TANK_RADIUS * 2;
    ctx.fillStyle = "#2a313d";
    ctx.fillRect(t.x - w / 2, t.y + TANK_RADIUS + 4, w, 4);
    ctx.fillStyle = t.hp > 1 ? "#5fd38d" : "#ff6b6b";
    ctx.fillRect(t.x - w / 2, t.y + TANK_RADIUS + 4, (w * Math.max(0, t.hp)) / TANK_MAX_HP, 4);

    ctx.fillStyle = "#cfd6e2";
    ctx.font = "12px system-ui, sans-serif";
    ctx.textAlign = "center";
    const label = `${t.name}${t.self ? " (you)" : ""}${t.dc ? " (reconnecting)" : ""}`;
    ctx.fillText(label, t.x, t.y - TANK_RADIUS - 8);
    ctx.globalAlpha = 1;
  }

  private drawScoreboard(tanks: DrawTank[]): void {
    const { ctx } = this;
    const rows = [...tanks].sort((a, b) => b.score - a.score).slice(0, 8);
    ctx.font = "12px ui-monospace, Menlo, monospace";
    ctx.textAlign = "right";
    rows.forEach((t, i) => {
      ctx.fillStyle = t.self ? "#ffffff" : "#8b95a5";
      ctx.fillText(`${t.name.slice(0, 12).padEnd(12)} ${String(t.score).padStart(3)}`, ARENA_WIDTH - 10, 18 + i * 15);
    });
  }
}
