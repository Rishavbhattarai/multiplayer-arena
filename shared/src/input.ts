/** Input is a bitmask so it is cheap to send and trivial to compare. */
export const Key = {
  Up: 1 << 0,
  Down: 1 << 1,
  Left: 1 << 2,
  Right: 1 << 3,
  Fire: 1 << 4,
} as const;

export const MOVE_KEYS_MASK = Key.Up | Key.Down | Key.Left | Key.Right;
export const ALL_KEYS_MASK = MOVE_KEYS_MASK | Key.Fire;

export function isDown(keys: number, key: number): boolean {
  return (keys & key) !== 0;
}

export function setKey(keys: number, key: number, down: boolean): number {
  return down ? keys | key : keys & ~key;
}
