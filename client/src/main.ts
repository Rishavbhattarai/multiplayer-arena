import { PROTOCOL_VERSION, type RoomInfo, type RoomMode, type WelcomeMessage } from "@tanks/shared";
import { readConfig } from "./config.js";
import { Keyboard } from "./keyboard.js";
import { NaiveGame, type HudStats } from "./naiveGame.js";
import { Connection } from "./net.js";
import { Renderer } from "./render.js";

const config = readConfig();

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
}

const lobby = $("lobby");
const game = $("game");
const nameInput = $<HTMLInputElement>("name");
const roomInput = $<HTMLInputElement>("roomCode");
const errorEl = $("lobbyError");
const roomList = $("roomList");
const hud = $("hud");

$("modeLabel").textContent = config.mode;
$("serverLabel").textContent = config.httpBase;
nameInput.value = localStorageGet("tanks.name") ?? "";

function localStorageGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function localStorageSet(k: string, v: string): void {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode etc. */
  }
}

function showError(msg: string): void {
  errorEl.textContent = msg;
}

async function createRoom(mode: RoomMode): Promise<string> {
  const res = await fetch(`${config.httpBase}/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) throw new Error(`create room failed: HTTP ${res.status}`);
  return ((await res.json()) as RoomInfo).roomId;
}

async function refreshRooms(): Promise<void> {
  try {
    const res = await fetch(`${config.httpBase}/rooms`);
    const rooms = (await res.json()) as RoomInfo[];
    roomList.replaceChildren();
    if (rooms.length === 0) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "No rooms yet. Create one.";
      roomList.append(li);
    }
    for (const r of rooms) {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = `${r.roomId} · ${r.mode} · ${r.players}/${r.maxPlayers}`;
      const btn = document.createElement("button");
      btn.textContent = "Join";
      btn.onclick = () => void joinRoom(r.roomId);
      li.append(label, btn);
      roomList.append(li);
    }
  } catch {
    roomList.replaceChildren();
    showError(`Cannot reach server at ${config.httpBase}. Is it running? (npm run dev:server)`);
  }
}

function renderHud(s: HudStats): void {
  const link = `${location.origin}${location.pathname}?room=${s.roomId}&mode=${s.mode}`;
  hud.innerHTML = "";
  const items: [string, string][] = [
    ["room", s.roomId],
    ["mode", s.mode],
    ["players", String(s.players)],
    ["rtt", s.rttMs === null ? "-" : `${s.rttMs.toFixed(0)} ms`],
    ["tick", String(s.serverTick)],
    ["snaps/s", String(s.snapsPerSec)],
    ["down", `${s.kbInPerSec.toFixed(1)} KB/s`],
  ];
  for (const [k, v] of items) {
    const span = document.createElement("span");
    span.append(`${k} `);
    const b = document.createElement("b");
    b.textContent = v;
    span.append(b);
    hud.append(span);
  }
  const a = document.createElement("span");
  a.textContent = `share: ${link}`;
  hud.append(a);
}

let joining = false;
async function joinRoom(roomId: string): Promise<void> {
  if (joining) return;
  joining = true;
  showError("");
  const name = nameInput.value.trim().slice(0, 16);
  localStorageSet("tanks.name", name);
  try {
    if (config.mode !== "naive") {
      // YOUR TURN (see YOUR_TURN.md, push 2/3): build the authoritative client
      // (input-only, later prediction/reconciliation/interpolation) and start it here.
      throw new Error(`mode "${config.mode}" has no client yet. Use ?mode=naive.`);
    }
    const net = await Connection.open(config.wsUrl);
    const welcome = await new Promise<WelcomeMessage>((resolve, reject) => {
      net.onMessage((m) => {
        if (m.t === "welcome") resolve(m);
        else if (m.t === "error") reject(new Error(`${m.code}: ${m.message}`));
      });
      net.onClose(() => reject(new Error("connection closed")));
      net.send({ t: "join", v: PROTOCOL_VERSION, roomId, name });
    });
    if (welcome.mode !== "naive") {
      net.close();
      throw new Error(`room ${roomId} is "${welcome.mode}" but this client is naive. Open it with ?mode=${welcome.mode}.`);
    }

    history.replaceState(null, "", `?room=${welcome.roomId}&mode=${welcome.mode}${location.search.includes("server=") ? `&server=${encodeURIComponent(config.httpBase)}` : ""}`);
    lobby.hidden = true;
    game.hidden = false;
    const g = new NaiveGame(net, welcome, new Keyboard(), new Renderer($<HTMLCanvasElement>("canvas")), renderHud);
    net.onClose(() => {
      g.stop();
      hud.textContent = "Disconnected from server. Reload to rejoin.";
    });
    g.start();
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  } finally {
    joining = false;
  }
}

$("create").onclick = async () => {
  try {
    await joinRoom(await createRoom(config.mode));
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
};
$("join").onclick = () => {
  const code = roomInput.value.trim().toUpperCase();
  if (code) void joinRoom(code);
};
$("refresh").onclick = () => void refreshRooms();

if (config.roomId) void joinRoom(config.roomId);
else void refreshRooms();
