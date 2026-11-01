import { createInterface } from 'node:readline/promises';

export const NO_TTY = "No terminal to answer prompts. Run with --yes, or with --config <file> for init.";

export interface Prompt {
  confirm(q: string): Promise<boolean>;
  edit(label: string, value: string): Promise<string>;
}

/** Readline prompts on stdin/stdout. Closing stdin before an answer rejects, which init reports as an error. */
export function readlinePrompt(): Prompt & { close(): void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    confirm: async (q) => /^y(es)?$/i.test((await rl.question(`${q} `)).trim()),
    edit: async (label, value) => (await rl.question(`${label} [${value}] (Enter keeps it): `)).trim() || value,
    close: () => rl.close(),
  };
}
