import { isAbsolute } from 'node:path';
// The §8.3 credential lists, as the spec gives them. Paths are never opened here, only named.
export const CREDENTIAL_FILES: readonly string[] = [
  '~/.ssh', '~/.aws', '~/.config/gcloud', '~/.azure', '~/.kube', '~/.docker/config.json',
  '~/.npmrc', '~/.yarnrc.yml', '~/.bunfig.toml', '~/.config/pnpm', '~/Library/Preferences/pnpm',
  '~/.pypirc', '~/.config/pip', '~/.config/pypoetry', '~/Library/Application Support/pypoetry', '~/.local/share/uv/credentials',
  '~/.config/gh', '~/.config/hub', '~/.git-credentials', '~/.config/git/credentials', '~/.gcm/store', '~/.password-store', '~/.netrc',
  '~/Library/Keychains', '~/.local/share/keyrings', '~/.local/share/kwalletd',
  '~/.cargo/credentials.toml', '~/.gem/credentials', '~/.m2/settings.xml', '~/.gradle/gradle.properties',
  '~/.terraformrc', '~/.terraform.d/credentials.tfrc.json', '~/.vault-token', '~/.config/op', '~/.config/anthropic',
  '~/.claude/.credentials.json',
  '/mnt/c/Users',
];

export const CREDENTIAL_ENV: readonly string[] = [
  'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'YARN_NPM_AUTH_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS', 'AZURE_CLIENT_SECRET', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
  'GITHUB_TOKEN', 'GH_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'CARGO_REGISTRY_TOKEN', 'GEM_HOST_API_KEY',
  'VAULT_TOKEN', 'TF_TOKEN_app_terraform_io', 'HARNESS_APP_KEY',
  'SSH_AUTH_SOCK', 'GIT_ASKPASS', 'SSH_ASKPASS', 'VSCODE_GIT_ASKPASS_MAIN', 'VSCODE_GIT_ASKPASS_NODE', 'VSCODE_GIT_ASKPASS_EXTRA_ARGS',
  'VSCODE_GIT_IPC_HANDLE', 'REMOTE_CONTAINERS_IPC', 'REMOTE_CONTAINERS_SOCKETS',
];

/** `~/` expanded against `home`. An expanded path with a glob character can't be a literal srt path, so it is skipped. */
export function credentialFiles(home: string): { files: string[]; skipped: string[] } {
  if (!home || !isAbsolute(home)) throw new Error('credentialFiles: home must be an absolute path');
  const files: string[] = [];
  const skipped: string[] = [];
  for (const f of CREDENTIAL_FILES) {
    const p = f.startsWith('~/') ? `${home}/${f.slice(2)}` : f;
    (/[*?[\]{}]/.test(p) ? skipped : files).push(p);
  }
  return { files, skipped };
}
