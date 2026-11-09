import { createInterface } from 'node:readline/promises';

export const NO_TTY = "No terminal to answer prompts. Run with --yes (add --config <file> for init), or use --dry-run to preview.";

export interface Prompt {
  confirm(q: string): Promise<boolean>;
  edit(label: string, value: string): Promise<string>;
}

/** Readline prompts on stdin/stdout. Closing stdin before a yes/no answer is a No; before an edit it rejects, which init reports as an error. */
export function readlinePrompt(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Prompt & { close(): void } {
  const rl = createInterface({ input, output });
  const closed = new Promise<string>((done) => rl.once('close', () => done('')));
  return {
    confirm: async (q) => /^y(es)?$/i.test((await Promise.race([rl.question(`${q} `).catch(() => ''), closed])).trim()),
    edit: async (label, value) => (await rl.question(`${label} [${value}] (Enter keeps it): `)).trim() || value,
    close: () => rl.close(),
  };
}
