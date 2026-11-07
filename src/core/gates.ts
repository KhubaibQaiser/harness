import type { HarnessConfig } from './config.js';

/** The gates `harness status` lists and the compaction state card names, in display order. */
export const GATES: [label: string, key: keyof HarnessConfig['checks']][] = [
  ['guard', 'guard'], ['protect', 'protect'], ['dep-verify', 'depVerify'], ['multi-file', 'multiFile'], ['tdd', 'tdd'], ['stop', 'stop'], ['pr-size', 'prSize'],
];
