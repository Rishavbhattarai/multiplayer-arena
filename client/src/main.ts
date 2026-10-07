import type { RoomInfo, RoomMode } from "@tanks/shared";
import { AuthoritativeGame } from "./authGame.js";
import { readConfig } from "./config.js";
import type { Game, HudItem } from "./game.js";
import { Keyboard, Mouse } from "./keyboard.js";
import { NaiveGame } from "./naiveGame.js";
import { isActive, type NetSimSettings } from "./netcode/netsim.js";
import { Renderer } from "./render.js";
import { JoinError, Session, connectAndJoin, loadToken, saveToken } from "./session.js";

const config = readConfig();
const netsim: NetSimSettings = { ...config.netsim };
const getNetsim = () => netsim;

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
}

const lobby = $("lobby");
const gameEl = $("game");
const nameInput = $<HTMLInputElement>("name");
const roomInput = $<HTMLInputElement>("roomCode");
const errorEl = $("lobbyError");
const roomList = $("roomList");
const hud = $("hud");

let createMode: RoomMode = config.mode;
$("modeLabel").textContent = createMode;
$("serverLabel").textContent = config.httpBase;
$("modeSwitch").onclick = (e) => {
  e.preventDefault();
  createMode = createMode === "naive" ? "authoritative" : "naive";
  $("modeLabel").textContent = createMode;
  updateUrl();
};

function storageGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function storageSet(k: string, v: string): void {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode etc. */
  }
}
nameInput.value = storageGet("tanks.name") ?? "";

function showError(msg: string): void {
  errorEl.textContent = msg;
}

let currentRoom: string | null = config.roomId;
function updateUrl(): void {
  const p = new URLSearchParams();
  if (currentRoom) p.set("room", currentRoom);
  p.set("mode", createMode);
  if (netsim.latencyMs) p.set("lag", String(netsim.latencyMs));
  if (netsim.jitterMs) p.set("jitter", String(netsim.jitterMs));
  if (netsim.lossPct) p.set("loss", String(netsim.lossPct));
  if (netsim.lossModel !== "tcp") p.set("lossModel", netsim.lossModel);
  if (new URLSearchParams(location.search).has("server")) p.set("server", config.httpBase);
  history.replaceState(null, "", `?${p.toString()}`);
}

// --- network simulator panel -------------------------------------------------
const nsLag = $<HTMLInputElement>("nsLag");
const nsJitter = $<HTMLInputElement>("nsJitter");
const nsLoss = $<HTMLInputElement>("nsLoss");
const nsModel = $<HTMLSelectElement>("nsModel");
function syncNetsimInputs(): void {
  nsLag.value = String(netsim.latencyMs);
  nsJitter.value = String(netsim.jitterMs);
  nsLoss.value = String(netsim.lossPct);
  nsModel.value = netsim.lossModel;
}
function readNetsimInputs(): void {
  netsim.latencyMs = Math.max(0, Number(nsLag.value) || 0);
  netsim.jitterMs = Math.max(0, Number(nsJitter.value) || 0);
  netsim.lossPct = Math.min(50, Math.max(0, Number(nsLoss.value) || 0));
  netsim.lossModel = nsModel.value === "drop" ? "drop" : "tcp";
  updateUrl();
}
for (const el of [nsLag, nsJitter, nsLoss, nsModel]) el.addEventListener("change", readNetsimInputs);
$("nsPreset").onclick = () => {
  Object.assign(netsim, { latencyMs: 150, jitterMs: 20, lossPct: 5, lossModel: "tcp" });
  syncNetsimInputs();
  updateUrl();
};
$("nsOff").onclick = () => {
  Object.assign(netsim, { latencyMs: 0, jitterMs: 0, lossPct: 0 });
  syncNetsimInputs();
  updateUrl();
};
syncNetsimInputs();
const netsimLabel = () =>
  isActive(netsim) ? `${netsim.latencyMs}ms ±${netsim.jitterMs} ${netsim.lossPct}% ${netsim.lossModel}` : "off";

// --- lobby -------------------------------------------------------------------
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

function renderHud(roomId: string, items: HudItem[]): void {
  hud.replaceChildren();
  for (const [k, v] of [["room", roomId] as HudItem, ...items]) {
    const span = document.createElement("span");
    span.append(`${k} `);
    const b = document.createElement("b");
    b.textContent = v;
    span.append(b);
    hud.append(span);
  }
}

let joining = false;
async function joinRoom(roomId: string): Promise<void> {
  if (joining) return;
  joining = true;
  showError("");
  const name = nameInput.value.trim().slice(0, 16);
  storageSet("tanks.name", name);
  try {
    // Resume a tank this tab already had in this room (e.g. after a reload), else join fresh.
    let first;
    const token = loadToken(roomId);
    try {
      first = await connectAndJoin(config.wsUrl, roomId, name, token, getNetsim);
    } catch (err) {
      if (!(token && err instanceof JoinError && err.code === "RESUME_FAILED")) throw err;
      saveToken(roomId, null);
      first = await connectAndJoin(config.wsUrl, roomId, name, null, getNetsim);
    }
    const { welcome } = first;
    currentRoom = welcome.roomId;
    updateUrl();
    lobby.hidden = true;
    gameEl.hidden = false;

    const canvas = $<HTMLCanvasElement>("canvas");
    const keyboard = new Keyboard();
    const renderer = new Renderer(canvas);
    const onHud = (items: HudItem[]) => renderHud(welcome.roomId, items);
    const game: Game =
      welcome.mode === "naive"
        ? new NaiveGame(welcome, keyboard, renderer, onHud)
        : new AuthoritativeGame(welcome, keyboard, new Mouse(canvas, keyboard), renderer, onHud, netsimLabel);
    const session = new Session(config.wsUrl, welcome.roomId, name, getNetsim, game, first, (m) => console.warn(m));
    game.start();

    $("dropConn").onclick = () => session.dropConnection();
    $("leave").onclick = () => {
      session.leave();
      game.stop();
      currentRoom = null;
      updateUrl();
      location.reload();
    };
    (window as unknown as { __tanks: unknown }).__tanks = {
      debug: () => ({ ...game.debug(), reconnects: session.reconnects, roomId: welcome.roomId }),
      netsim,
      drop: () => session.dropConnection(),
    };
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  } finally {
    joining = false;
  }
}

$("create").onclick = async () => {
  try {
    await joinRoom(await createRoom(createMode));
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
