/**
 * Room -> game-server mapping used by the lobby/matchmaker.
 *
 * With a single server this is just bookkeeping, but routing every lookup
 * through this interface means horizontal scaling (stretch goal) only needs a
 * shared implementation, not changes to callers.
 *
 * Not built: RedisRoomRegistry (HSET rooms <roomId> <serverId>, plus a
 * per-server heartbeat key with a TTL so rooms of a dead server can be reaped).
 * It only matters once there is more than one game server.
 */
export interface RoomRegistry {
  register(roomId: string, serverId: string): Promise<void>;
  lookup(roomId: string): Promise<string | undefined>;
  unregister(roomId: string): Promise<void>;
  list(): Promise<Map<string, string>>;
}

export class InMemoryRoomRegistry implements RoomRegistry {
  private readonly rooms = new Map<string, string>();

  async register(roomId: string, serverId: string): Promise<void> {
    this.rooms.set(roomId, serverId);
  }
  async lookup(roomId: string): Promise<string | undefined> {
    return this.rooms.get(roomId);
  }
  async unregister(roomId: string): Promise<void> {
    this.rooms.delete(roomId);
  }
  async list(): Promise<Map<string, string>> {
    return new Map(this.rooms);
  }
}
