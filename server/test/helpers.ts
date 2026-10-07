import {
  decodeServerMessage,
  SnapshotStore,
  type EntitySnapshot,
  type InputMessage,
  type ServerMessage,
  type SnapshotMessage,
} from "@tanks/shared";
import type { PlayerConnection, RejectReason, SendKind } from "../src/room.js";
import type { Room } from "../src/room.js";

/** Fake connection that decodes everything the room sends and reconstructs deltas like a real client. */
export class FakeConn implements PlayerConnection {
  readonly sent: ServerMessage[] = [];
  readonly kinds: SendKind[] = [];
  bytes = 0;
  readonly store = new SnapshotStore();
  /** Latest reconstructed full state. */
  world = new Map<number, EntitySnapshot>();

  sendRaw(data: string, kind: SendKind): void {
    const msg = decodeServerMessage(data);
    if (!msg) throw new Error(`room sent an undecodable frame: ${data}`);
    this.sent.push(msg);
    this.kinds.push(kind);
    this.bytes += data.length;
    if (msg.t === "snap") {
      const w = this.store.apply(msg);
      if (w) this.world = w;
    }
  }
  last<T extends ServerMessage["t"]>(t: T): Extract<ServerMessage, { t: T }> | undefined {
    return this.sent.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t).at(-1);
  }
  snaps(): SnapshotMessage[] {
    return this.sent.filter((m): m is SnapshotMessage => m.t === "snap");
  }
}

export function joinOk(room: Room, name: string, conn = new FakeConn()) {
  const r = room.join(name, conn);
  if (!r.ok) throw new Error(`join failed: ${r.code}`);
  return { player: r.player, conn };
}

export function input(seq: number, keys: number, extra: Partial<InputMessage> = {}): InputMessage {
  return { t: "input", seq, keys, aim: 0, vt: 0, ack: 0, ...extra };
}

export function rejectRecorder() {
  const rejects: RejectReason[] = [];
  return { rejects, events: { onReject: (_r: string, _p: number, reason: RejectReason) => rejects.push(reason) } };
}
