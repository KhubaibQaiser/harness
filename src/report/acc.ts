import type { TRec } from './transcript.js';
import type { Turn } from './turns.js';

export type Bucket = '1-10' | '11-30' | '31-100' | '100+';
export const bucketOf = (turn: number): Bucket => (turn <= 10 ? '1-10' : turn <= 30 ? '11-30' : turn <= 100 ? '31-100' : '100+');

export interface SessionCtx { id: string; turns: number; compactions: number; edited: string[] }
/** One metric. It sees every record and every finished turn of a session, and keeps aggregates only. */
export interface Acc<R> {
  rec?(s: SessionCtx, r: TRec): void;
  turn?(s: SessionCtx, t: Turn): void;
  endSession?(s: SessionCtx): void;
  result(): R;
}
