// Leaf module: no imports, so the hook bundle can use it.
export const PREFIX_RE = /^[a-z0-9-]+\/$/;

export interface PresetGit { branch_prefixes: string[]; no_ai_trailer: boolean; pr_size_warning: boolean }

export const slug = (topic: string): string =>
  topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '') || 'topic';

export const suggestBranches = (prefixes: string[], topic: string): string[] => prefixes.map((p) => p + slug(topic));
