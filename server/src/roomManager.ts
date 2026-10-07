import { randomInt } from "node:crypto";
import { EMPTY_ROOM_TTL_MS, MAX_PLAYERS_PER_ROOM, type RoomInfo, type RoomMode } from "@tanks/shared";
import { Room, type RoomEvents } from "./room.js";
import type { RoomRegistry } from "./roomRegistry.js";

const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const ID_LENGTH = 6;

export function generateRoomId(): string {
  let id = "";
  for (let i = 0; i < ID_LENGTH; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  return id;
}

export interface RoomManagerOptions {
  registry: RoomRegistry;
  serverId: string;
  now?: () => number;
  emptyRoomTtlMs?: number;
  events?: RoomEvents;
  reconnectGraceMs?: number;
}

/** Owns all rooms hosted by this process and keeps the registry in sync. */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly registry: RoomRegistry;
  readonly serverId: string;
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly opts: RoomManagerOptions;

  constructor(opts: RoomManagerOptions) {
    this.registry = opts.registry;
    this.serverId = opts.serverId;
    this.now = opts.now ?? Date.now;
    this.ttl = opts.emptyRoomTtlMs ?? EMPTY_ROOM_TTL_MS;
    this.opts = opts;
  }

  async createRoom(mode: RoomMode, delta = true): Promise<Room> {
    let id = generateRoomId();
    while (this.rooms.has(id)) id = generateRoomId();
    const room = new Room(id, mode, this.now(), {
      delta,
      ...(this.opts.events ? { events: this.opts.events } : {}),
      ...(this.opts.reconnectGraceMs !== undefined ? { reconnectGraceMs: this.opts.reconnectGraceMs } : {}),
    });
    this.rooms.set(id, room);
    await this.registry.register(id, this.serverId);
    return room;
  }

  getRoom(id: string): Room | undefined {
    return this.rooms.get(id.toUpperCase());
  }

  info(room: Room): RoomInfo {
    return {
      roomId: room.id,
      mode: room.mode,
      delta: room.delta,
      players: room.playerCount,
      maxPlayers: MAX_PLAYERS_PER_ROOM,
      serverId: this.serverId,
    };
  }

  list(): RoomInfo[] {
    return [...this.rooms.values()].map((r) => this.info(r));
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  get playerCount(): number {
    let n = 0;
    for (const r of this.rooms.values()) n += r.playerCount;
    return n;
  }

  get connectedCount(): number {
    let n = 0;
    for (const r of this.rooms.values()) n += r.connectedCount;
    return n;
  }

  /** One server tick: step every room, then reap rooms empty for longer than the TTL. */
  stepAll(): void {
    const now = this.now();
    for (const room of this.rooms.values()) room.step(now);
    this.reapEmptyRooms();
  }

  reapEmptyRooms(): string[] {
    const now = this.now();
    const reaped: string[] = [];
    for (const [id, room] of this.rooms) {
      if (room.emptySince !== null && now - room.emptySince >= this.ttl) {
        this.rooms.delete(id);
        reaped.push(id);
        void this.registry.unregister(id);
      }
    }
    return reaped;
  }
}
