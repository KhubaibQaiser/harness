# M4 backend and infra: tool choices

Date: 2026-11-13. Question: which scanners, linters, auditors, official plugins and guard signals should the M4 backend/infra catalog items use? Plan context: `.superpowers/sdd/m4/2026-11-13-m4-coverage-plan.md` section 2.1 (S1 to S6, B4 to B6).

Labels: **UNVERIFIED** = not confirmed from a primary source this session. **Secondary** = a third-party write-up, not the vendor. **Estimate** = my arithmetic.

Rules used for every row:
- "Latest stable" means the newest non-prerelease release published on or before 2026-10-30 (two weeks before today). Where a newer release exists it is named and excluded as too fresh.
- Dates come from the GitHub releases API (`gh api repos/<owner>/<repo>/releases`), the Go module proxy, PyPI or RubyGems, as stated per row. Licenses are the GitHub-reported SPDX id unless noted.
- Reputation for false positives is mostly anecdotal. Where I found no measurement I say so.

---

## 0. Verdicts

| Area | Pick | One-line reason |
|---|---|---|
| IaC scanner | Checkov 3.4.0 (pip, hash-pinned) | Apache-2.0, widest coverage list, only measured precision figure favours it. Trivy rejected for now after its March 2026 compromise. |
| Migration linter | Squawk 2.71.0 (Postgres only) | Apache-2.0, 79 Postgres safety rules. Atlas lint is Pro-only and login-gated. MySQL has no verified free linter. |
| Dependency audit | Native audit per ecosystem, OSV-Scanner as the optional cross-ecosystem net | No new tool for npm; OSV-Scanner has SHA256SUMS and SLSA provenance. |
| Secrets | Gitleaks 8.30.1, local hook plus CI | Checksum published, already pinned in this repo's CI. |
| Official plugins | Terraform (HashiCorp), AWS, Azure, Cloud SQL/AlloyDB, Neon, Supabase, Prisma verified in the official marketplace | Kubernetes and Pulumi are not in the marketplace. Kubernetes has an official-registry MCP server. |
| Guard signals | Section 6 | Proposed mapping for the owner's deny/ask rule. |

---

## 1. IaC security scanner

Scope wanted: Terraform, Kubernetes manifests, Helm, Dockerfile, CloudFormation.

### Candidates

| | Checkov | Trivy (`trivy config`) | KICS |
|---|---|---|---|
| Official URL | https://github.com/bridgecrewio/checkov , https://www.checkov.io | https://github.com/aquasecurity/trivy , https://trivy.dev | https://github.com/Checkmarx/kics , https://docs.kics.io |
| License | Apache-2.0 (GitHub; PyPI says "Apache License 2.0") | Apache-2.0 | Apache-2.0 |
| Latest stable (>= 2 weeks) | **3.4.0**, 2026-10-28 (PyPI upload 2026-10-28T20:30). Newer 3.4.5 (2026-11-12) excluded | **v0.76.1**, 2026-10-21. Newer v0.76.2 (2026-11-05) excluded | **v2.2.0**, 2026-09-17. Newer v2.2.1 (2026-11-09) excluded |
| Install | `pip install checkov`, `brew install checkov`, Docker ([install doc](https://github.com/bridgecrewio/checkov/blob/main/docs/2.Basics/Installing%20Checkov.md)) | Release tarballs, brew, Docker | Docker, brew, Go build. The v2.2.0 GitHub release has no binary assets (asset count 0), so there is nothing to checksum there |
| Checksum pin | Via pip: `==3.4.0` plus `--require-hashes` with hashes from PyPI. No checksum file from the project. Docker by image digest | Yes. `trivy_0.76.1_checksums.txt` plus a `.sigstore.json` per archive on the release | No release checksums. Docker image digest only |
| Checks | Terraform, CloudFormation (incl. SAM), ARM, Serverless, Helm, Kubernetes, Docker; "more than 750" built-in policies per [checkov.io](https://www.checkov.io/1.Welcome/What%20is%20Checkov.html). Secondary sources say 1,000+ | Dockerfile, Kubernetes, Terraform, CloudFormation, ARM, Helm; `trivy config DIR` ([docs](https://trivy.dev/latest/docs/scanner/misconfiguration/)) | Terraform, CloudFormation, Kubernetes, Helm, Dockerfile, Ansible, Pulumi, Bicep and more ([platforms](https://docs.kics.io/latest/platforms/)). Query count not published on that page |
| False-positive reputation | One hand-graded 200-finding sample on one Terraform estate: Checkov 91%, Trivy config 86%, KICS 73% precision ([safeguard.sh](https://safeguard.sh/resources/blog/checkov-3-2-2026-iac-scanning-review), secondary, single sample, not reproducible). No independent benchmark found | Same sample, 86%. Opinion posts claiming big FP cuts have no method; ignore | Same sample, 73%, "more rules, more false positives" |
| Maintenance | Release 2026-10-28, push 2026-11-12. Very active | Release 2026-11-05, push 2026-11-12. Very active | Release 2026-11-09, push 2026-11-10. Active |
| Security incident | None found | **Yes.** On 2026-03-19 a malicious v0.69.4 and rewritten action tags were pushed; Docker Hub v0.69.5 and v0.69.6 on 2026-03-22. Advisory [GHSA-69fq-xp46-6x23](https://osv.dev/vulnerability/GHSA-69fq-xp46-6x23); Aqua's write-up: https://www.aquasec.com/blog/trivy-supply-chain-attack/ . Later 2026 GHSAs: tar bomb in Helm parser (GHSA-q3fv-x8vg-qqm4), plugin path traversal (GHSA-8rc5-4fr6-64pw) | Wiz reports a parallel `kics-github-action` compromise ([Wiz](https://wiz.io/blog/trivy-compromised-teampcp-supply-chain-attack), secondary, not confirmed from a Checkmarx source: UNVERIFIED) |

### Also considered, rejected
- **Terrascan** (https://github.com/tenable/terrascan): Apache-2.0, last release v1.19.9 on 2024-09-18, GitHub flag `archived: true`, README says "no longer maintained". Out.
- **tfsec** (https://github.com/aquasecurity/tfsec): MIT, last release v1.28.14 on 2025-05-02, last push 2026-03-25. A secondary source says it was merged into Trivy ([appsecsanta](https://appsecsanta.com/checkov-alternatives)); I did not confirm a deprecation notice in the README. Treat as dead.

### Recommendation
**Checkov 3.4.0**, run as `checkov -d . --compact --quiet` in a CI job, installed from PyPI with hashes (or a Docker digest). Reasons:
1. Covers all five required types with one tool.
2. Only measured precision figure is best of the three (one sample, say so in any user-facing text).
3. No supply-chain incident found. Trivy's incident was recent enough (March 2026, ongoing investigation as of Aqua's last update, 1 April 2026) that a security-first default should not depend on it. Revisit Trivy once the owner is satisfied.
4. Pinning by tag alone is not enough here, since the Trivy incident rewrote tags. Pin the PyPI hashes or the image digest.

Weak point: pip with `--require-hashes` needs a full hashed requirements file including transitive dependencies, which the harness would have to generate. Whether harness can ship a pre-resolved hash file per version is an open question (below).

Sources: GitHub releases API for each repo; PyPI JSON for checkov; the doc URLs in the table.

---

## 2. Database migration safety linter

### Candidates

| | Squawk | Atlas (`atlas migrate lint`) | strong_migrations (Rails) | django-migration-linter |
|---|---|---|---|---|
| Official URL | https://github.com/sbdchd/squawk , https://squawkhq.com | https://github.com/ariga/atlas , https://atlasgo.io/versioned/lint | https://github.com/ankane/strong_migrations | https://github.com/3YOURMIND/django-migration-linter |
| License | Apache-2.0 per GitHub; npm package says `(Apache-2.0 OR MIT)` | Apache-2.0 repo, but lint is gated (next row) | MIT | Apache-2.0 |
| Latest stable (>= 2 weeks) | **v2.71.0**, 2026-10-29. Newer v2.72.0 (2026-11-08) excluded | v1.3.0, 2026-08-02 | **2.8.0**, 2026-05-14 (RubyGems; no GitHub Release objects, tags only) | v6.0.0, 2026-01-04 |
| Install | npm `squawk-cli`, or release binary (`squawk-linux-x64`, `squawk-darwin-arm64`, musl builds) | Binary | `gem "strong_migrations"` | pip |
| Checksum pin | npm lockfile integrity. Release has no checksum file (assets are bare binaries); GitHub may show a per-asset digest, not checked for squawk | n/a, see gate | Gemfile.lock | pip hashes |
| What it checks | Postgres only. 79 rules, e.g. `ban-drop-table`, `require-concurrent-index-creation`, `require-lock-timeout`, `prefer-bigint-over-int`, `adding-required-field` ([rules](https://squawkhq.com/docs/rules)) | Destructive changes, breaking changes, table locks and rewrites, custom policies. Postgres, MySQL, MariaDB and others | Unsafe Rails migrations. Databases supported: UNVERIFIED (not fetched) | Backward-incompatible Django migrations. Django only |
| Gate / catch | None found | **`atlas migrate lint` is "available only to Atlas Pro users"** since v0.38 and needs `atlas login` ([lint doc](https://atlasgo.io/versioned/lint)). Site terms limit competing use | Rails projects only | Django projects only |
| False positives | No measurement found. UNVERIFIED. Docs page did not cover config or transaction assumptions | None found | None found | None found |
| Maintenance | Release 2026-11-08, push 2026-11-13. Very active | Release 2026-08-02, push 2026-11-05 | Push 2026-11-02, release 2026-05-14 | Last release 2026-01-04, push 2026-10-19 |

### MySQL
No free, license-clean MySQL migration linter was verified. Atlas supports MySQL but only under Pro. Say so in the catalog note rather than invent one.

### Recommendation
- **Squawk 2.71.0** as the SQL-file linter for Postgres (`squawk migrations/*.sql`), installed via npm with the lockfile, or the binary with a sha256 the harness records at catalog time.
- **strong_migrations** and **django-migration-linter** as framework-specific optional items, shown only when `Gemfile` has rails or Django is detected.
- **Do not recommend Atlas lint**: login plus paid tier breaks "harness installs nothing that needs an account".
- Squawk lints SQL files. Prisma, Drizzle and Alembic generate SQL, so it fits `prisma/migrations/*/migration.sql` and `drizzle/*.sql` directly, but Alembic Python migrations are not covered (UNVERIFIED: I did not test; Alembic offline mode `--sql` could feed it).

Sources: GitHub releases API, https://squawkhq.com/docs/rules , https://atlasgo.io/versioned/lint , RubyGems API for strong_migrations.

---

## 3. Dependency audit per ecosystem

| Ecosystem | Tool | Official URL | License | Latest stable (>= 2 weeks) | Install and pin | Notes |
|---|---|---|---|---|---|---|
| npm | `npm audit` | https://docs.npmjs.com/cli/commands/npm-audit | built in (npm) | n/a | none | Not re-fetched this session; behaviour per npm docs |
| pnpm | `pnpm audit` | https://pnpm.io/cli/audit | built in | n/a | none | Not re-fetched |
| yarn Berry | `yarn npm audit` | https://yarnpkg.com/cli/npm/audit | built in | n/a | none | Plan S4 already uses this |
| Python | **pip-audit** | https://github.com/pypa/pip-audit | Apache-2.0 | **v2.10.1**, 2026-06-10 | pip with hashes. No checksum file | Active (push 2026-11-11). Uses the PyPI advisory data (per project README, not re-fetched) |
| Go | **govulncheck** (`golang.org/x/vuln`) | https://pkg.go.dev/golang.org/x/vuln/cmd/govulncheck | BSD-3-Clause (repo `golang/vuln`) | **v1.9.0**, 2026-10-11 (Go module proxy `.info`) | `go install golang.org/x/vuln/cmd/govulncheck@v1.9.0`; Go sumdb verifies the module | Needs a Go toolchain |
| Rust | **cargo-audit** | https://github.com/rustsec/rustsec | `Apache-2.0 OR MIT` (cargo-audit Cargo.toml). GitHub's repo-level license check shows NOASSERTION and no root license file via the API | **0.22.2**, 2026-06-05. 0.23.0 (2026-11-10) excluded | `cargo install cargo-audit --version 0.22.2 --locked` | Active |
| Ruby | **bundler-audit** | https://github.com/rubysec/bundler-audit | **GPL-3.0** (GitHub) | v0.9.3, 2025-11-28 | `gem install bundler-audit -v 0.9.3` | Copyleft: fine to run as a dev tool, but flag it in the catalog license field and have the owner decide |
| All | **OSV-Scanner** | https://github.com/google/osv-scanner , https://google.github.io/osv-scanner/ | Apache-2.0 | **v2.7.0**, 2026-10-12. Newer v2.7.1 (2026-11-09) excluded | Release has `osv-scanner_SHA256SUMS` and `multiple.intoto.jsonl`; docs say the binaries are "SLSA3 compliant" ([installation.md](https://github.com/google/osv-scanner/blob/main/docs/installation.md)) | Best checksum and provenance story of the lot. Lockfile based, one tool for many ecosystems |

False-positive reputation: not measured for any of these. Audit tools report advisories for packages in the lockfile whether or not the vulnerable code path is used. `govulncheck` is the exception by design (call-graph reachability, per Go docs, not re-fetched). UNVERIFIED for the rest.

### Recommendation
1. Keep S4 as planned: native audit for npm, pnpm, yarn. No new binary.
2. For non-JS repos use the native tool per language (pip-audit, govulncheck, cargo-audit; bundler-audit with the GPL flag).
3. Offer **OSV-Scanner 2.7.0** as the single pinned, checksum-verified option, particularly when the repo has several ecosystems.

Sources: GitHub releases API; Go proxy `https://proxy.golang.org/golang.org/x/vuln/@v/v1.9.0.info`; osv-scanner installation doc.

---

## 4. Gitleaks

All from https://github.com/gitleaks/gitleaks (MIT per GitHub).

- **v8.30.1 release date:** 2026-03-21T02:17:58Z (GitHub releases API). It is still the latest release (previous: v8.30.0 2025-11-26). Repo push activity continues (a dependabot merge on 2026-10-23), so it is maintained but releases are infrequent.
- **Checksum publication:** yes. Release asset `gitleaks_8.30.1_checksums.txt` (its own sha256 per GitHub is `061476c21adaf5441516f96f185c1a4706a83cd6329b9b38762271b3d4a52fae`). I found no signature, attestation or SBOM asset in the asset list.
- **Plan value confirmed:** GitHub reports sha256 `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb` for `gitleaks_8.30.1_linux_x64.tar.gz`, which equals the value in the plan and this repo's `ci.yml`. (Note the GitHub digest comes from the same release page, so it only confirms consistency, not independence. The checksums.txt is the same trust root.)
- **Pre-commit hook:** from `.pre-commit-hooks.yaml` at the repo root, three hook ids, all with `pass_filenames: false`:
  - `gitleaks`: entry `gitleaks git --pre-commit --redact --staged --verbose`, `language: golang` (pre-commit builds it from the pinned rev).
  - `gitleaks-docker`: same entry via `zricethezav/gitleaks`.
  - `gitleaks-system`: same entry, `language: system` (uses the binary already on PATH).
  - README setup: add the repo and a `rev:` to `.pre-commit-config.yaml`, then `pre-commit install`; bypass is `SKIP=gitleaks git commit`. The README's example `rev` is v8.24.2, which is stale, so pin `v8.30.1` instead. Source: https://github.com/gitleaks/gitleaks/blob/master/README.md .
  - **Fit for harness:** use `gitleaks-system` so harness installs nothing globally, matching plan S2 ("skips with a note when missing"). The `gitleaks` id needs a Go toolchain, and a tag in `rev` is mutable, so use the full commit sha of v8.30.1 (not looked up here; do it when writing the template).
- **Hook plus CI together** (owner's choice): hook = fast feedback on staged changes, bypassable with `--no-verify` or `SKIP`; CI = non-bypassable full-history scan (`gitleaks git --redact --verbose .` with `fetch-depth: 0`, as this repo does). Both must use `--redact`. Baseline and allowlists: `--baseline-path`, `[[allowlists]]` in config, inline `gitleaks:allow`, `.gitleaksignore` (marked experimental in the README).
- **Avoid `gitleaks-action`**: https://github.com/gitleaks/gitleaks-action is v3.0.0 (2026-05-30), license reported as NOASSERTION. The ci.yml comment in this repo also records a reason for the binary route (permissions and commit-range scanning). I did not verify the action's licensing terms: UNVERIFIED.

---

## 5. Official Claude Code plugins and MCP servers

Verified source: `anthropics/claude-plugins-official` (Apache-2.0), file `.claude-plugin/marketplace.json`, 316 plugin entries when read on 2026-11-13. Each entry below is in that file. Marketplace entries pin a git sha or path; I list the source repo. Versions of the vendor servers come from GitHub releases.

| Name | Vendor and source (from marketplace) | Status |
|---|---|---|
| `terraform` | HashiCorp. In-repo `external_plugins/terraform`. Its `.mcp.json` runs `docker run -i --rm -e TFE_TOKEN hashicorp/terraform-mcp-server:0.4.0`. File last changed in that repo 2026-03-26 | **Verified.** Server upstream: https://github.com/hashicorp/terraform-mcp-server , MPL-2.0, latest v1.4.1 (2026-10-23). The plugin pins 0.4.0, which is older than 1.4.1, and passes a Terraform Cloud token env var. Registry also lists `io.github.hashicorp/terraform-mcp-server` (versions 0.3.2 to 0.5.0 seen in a limited search) |
| `aws-core`, `aws-agents`, `aws-agents-for-devsecops`, `aws-data-analytics`, `aws-startup-advisor` | Amazon Web Services; https://github.com/aws/agent-toolkit-for-aws | **Verified** |
| `aws-serverless`, `deploy-on-aws`, `databases-on-aws`, `aws-amplify`, `aws-transform` | https://github.com/awslabs/agent-plugins (no author field in marketplace) | Verified as listed; author field empty |
| `azure` | https://github.com/microsoft/azure-skills (author field empty) | Verified as listed |
| `azure-sql-developer` | Microsoft; https://github.com/microsoft/azure-sql-database-container | **Verified** |
| `cloud-sql-postgresql`, `cloud-sql-mysql`, `alloydb`, `google-cloud-storage` | Google LLC; `gemini-cli-extensions/*` repos | **Verified** as Google-authored in the marketplace. No general GCP or GKE plugin found by name or description search |
| `neon`, `supabase`, `prisma` | Neon, Supabase community org, Prisma | Verified as listed. `supabase` source is `supabase-community/supabase-plugin` |
| `cloudflare`, `vercel`, `netlify-skills`, `railway`, `render` | https://github.com/cloudflare/skills , https://github.com/vercel/vercel-plugin , https://github.com/netlify/context-and-tools , https://github.com/railwayapp/railway-skills , https://github.com/render-oss/render-plugin-claude-code | Verified as listed |
| Kubernetes | `containers/kubernetes-mcp-server`, https://github.com/containers/kubernetes-mcp-server , Apache-2.0, latest v0.1.1 (2026-10-29; v0.1.2 on 2026-11-04 excluded) | **Official MCP registry only**: `io.github.containers/kubernetes-mcp-server` (registry versions 0.0.50 to 0.0.64 seen in a limited search, status active). Not in the Claude marketplace. Whether `containers` is the vendor's own org: UNVERIFIED |
| Pulumi | none found in marketplace or the MCP registry search | **Unverified / not found** |
| Fly.io | none found in marketplace or the MCP registry search | **Unverified / not found** |
| General Postgres MCP | The archived reference server and `crystaldba/postgres-mcp` (MIT, v0.3.0, 2025-05-16, last push 2026-08-17) | **Unverified** as official; third party, not in the marketplace by name search |
| `aikido` | Marketplace description mentions IaC detection | Needs an Aikido account (plan note); leave discouraged |

Caveats:
- The marketplace lists `awslabs/agent-plugins` entries with an empty author field. "Official" here means "listed by Anthropic in its marketplace", not "vendor-attested".
- I did not inspect the contents of any plugin beyond Terraform's `.mcp.json`. Context cost and side effects (an MCP server given cloud credentials can mutate infrastructure) must be measured before an item lands. The harness guard cannot see mutations made through an MCP tool call the way it sees a Bash command: open question.
- Security note for the owner: a database or cloud MCP server is an alternate path around the Bash guard rules in section 6.

---

## 6. Detection signals for ad-hoc infra mutations versus IaC coverage

Feeds the ruling: deny a direct mutating command when the repo has IaC covering it, otherwise ask; always deny unattended. Everything in 6.1 is a proposed mapping, not a verified standard. Command lists in 6.2 are tagged by how I checked them.

### 6.1 Files showing IaC coverage

"Covers" lists which command families the file would make redundant to run by hand.

| File or dir | Tool | Covers (commands to deny when present) |
|---|---|---|
| `*.tf`, `*.tf.json`, `.terraform.lock.hcl`, `terraform.tfvars` | Terraform / OpenTofu | terraform, tofu; cloud CLIs (aws, gcloud, az) for resources the code manages |
| `terragrunt.hcl` | Terragrunt | terraform, terragrunt |
| `Pulumi.yaml`, `Pulumi.yml`, `Pulumi.<stack>.yaml` | Pulumi | pulumi, cloud CLIs |
| `cdk.json` | AWS CDK | cdk, aws |
| `template.yaml` with `AWSTemplateFormatVersion` or `Transform: AWS::Serverless`, `samconfig.toml` | CloudFormation / SAM | sam, aws cloudformation, aws |
| `serverless.yml`, `serverless.yaml`, `serverless.ts` | Serverless Framework | serverless, sls, aws |
| `sst.config.ts` | SST | sst, aws |
| `Chart.yaml` (root or `charts/*/`), `values.yaml` | Helm | helm, kubectl |
| `kustomization.yaml`, `kustomization.yml`, `Kustomization` | Kustomize | kubectl, kustomize |
| YAML with `apiVersion:` and `kind:` in `k8s/`, `manifests/`, `deploy/` | Plain Kubernetes manifests | kubectl |
| `skaffold.yaml`, ArgoCD `Application` or Flux `Kustomization` manifests | Delivery tooling (GitOps) | kubectl (strongest case: cluster state is owned by a controller) |
| `fly.toml` | Fly.io | flyctl, fly |
| `vercel.json` | Vercel | vercel. `vercel.json` is optional for Vercel projects, so also check a `.vercel/` dir (project link): absence proves nothing |
| `wrangler.toml`, `wrangler.json`, `wrangler.jsonc` | Cloudflare Workers | wrangler |
| `netlify.toml` | Netlify | netlify |
| `render.yaml` | Render Blueprint | render |
| `railway.json`, `railway.toml` | Railway | railway |
| `amplify.yml`, `amplify/` | AWS Amplify | amplify, aws |
| `app.yaml`, `cloudbuild.yaml` | Google App Engine / Cloud Build | gcloud |
| `*.bicep`, ARM `azuredeploy.json` | Azure | az |
| `docker-compose.yml`, `compose.yaml` | Compose (local/single host) | docker compose |
| `ansible.cfg`, `playbooks/`, `inventory` | Ansible | ansible-playbook |
| `crossplane` manifests | Crossplane | kubectl |
| Migration dirs: `prisma/migrations`, `drizzle`, `supabase/migrations`, `migrations`, `db/migrate`, `alembic/versions` (plan section 3) | DB migrations | migrate/push commands for that tool; direct `psql`/`mysql` DDL |

Judgement notes (mine):
- Cloud CLIs (`aws`, `gcloud`, `az`) are the hard case. A repo with Terraform does not tell you which resources Terraform manages, so "IaC covers it" is coarse for them. Cheapest honest rule: any IaC file for that cloud present means deny mutating `aws`/`gcloud`/`az`; none means ask. Needs the owner's confirmation.
- File presence in a subdirectory or monorepo app counts only if the command's cwd is under it. Plan section 3 already makes `*.tf` detection recursive.
- A markers-only check can be spoofed by an empty file. That is acceptable for an ask/deny hint, not a security boundary.

### 6.2 Mutating versus read-only subcommands

Tag key: **[doc]** = confirmed from the cited official page this session. **[doc+gk]** = page confirms some entries, rest is general knowledge of the CLI. **[gk]** = general knowledge, not verified this session (UNVERIFIED).

Common caveat: wrappers, `bash -c`, `xargs`, `env VAR=x cmd`, `sudo`, quoted forms, and aliases bypass any text-based match. The guard is a speed bump, not a boundary.

| Tool | Mutating | Read-only / safe | Source |
|---|---|---|---|
| terraform / tofu | `apply`, `destroy`, `import`, `refresh`, `taint`, `untaint`, `force-unlock`, `state rm`, `state mv`, `state push`, `workspace new/delete` | `plan`, `validate`, `show`, `output`, `providers`, `graph`, `modules`, `version`, `state list`, `state show`. Not strictly read-only: `fmt` rewrites `.tf` files, `init` and `get` download providers and modules, `login` writes local credentials. `plan` takes a state lock and refreshes by default, so it reads cloud APIs [gk] | [doc+gk] https://developer.hashicorp.com/terraform/cli/commands |
| pulumi | `up`, `destroy`, `refresh`, `import`, `state delete`, `state rename`, `stack rm`, `config set` (stack config and secrets), `cancel` | `preview`, `stack` (view), `config` (view), `logs` | [doc+gk] https://www.pulumi.com/docs/iac/cli/commands/ (page does not describe the sub-subcommands) |
| cdk | `deploy`, `destroy`, `bootstrap`, `import` | `synth`, `diff`, `ls`, `doctor` | [gk] |
| kubectl | `apply`, `create`, `delete`, `patch`, `replace`, `edit`, `scale`, `autoscale`, `rollout restart/undo/pause/resume`, `drain`, `cordon`, `uncordon`, `taint`, `label`, `annotate`, `set`, `run`, `expose`, `debug`, `certificate`, `cp` (into a pod), `exec` (can run anything in the pod) | `get`, `describe`, `logs`, `diff`, `events`, `explain`, `api-resources`, `api-versions`, `cluster-info`, `auth can-i`, `top`, `version`, `wait`, `config view`, `config get-*`, `config current-context`. `port-forward` opens a tunnel only. `--dry-run=client` sends nothing; `--dry-run=server` validates server side without persisting [gk] | [doc+gk] https://kubernetes.io/docs/reference/kubectl/ (page marks no command read-only; classification is mine) |
| helm | `install`, `upgrade`, `uninstall`, `rollback`, `push`, `repo add/remove`, `plugin install/uninstall`, `registry login` (local) | `list`, `status`, `get`, `history`, `show`, `template`, `lint`, `search`, `verify`, `version`, `env`, `package`, `pull`, `dependency`, `create` (local files). `test` runs test pods in the cluster, so treat as mutating-ish [gk]. `install` and `upgrade` accept `--dry-run` [gk] | [doc] subcommand list at https://helm.sh/docs/helm/helm/ ; classification is mine |
| aws | Verbs `create-*`, `delete-*`, `put-*`, `update-*`, `modify-*`, `terminate-*`, `run-*`, `start-*`, `stop-*`, `attach-*`, `detach-*`, `deploy`, `s3 cp/mv/rm/sync/mb/rb`, `cloudformation deploy/delete-stack`, `iam *` writes, `sts assume-role` (mints credentials, not a resource change) | `describe-*`, `list-*`, `get-*`, `ls`, `s3 ls`, `sts get-caller-identity`, `--dryrun` flag on `s3 cp/mv/rm/sync` | [gk] naming convention, not a documented guarantee. Some `get-*` calls return secrets (e.g. `secretsmanager get-secret-value`, `ssm get-parameter --with-decryption`) |
| gcloud | `create`, `delete`, `update`, `deploy`, `add-iam-policy-binding`, `remove-iam-policy-binding`, `set-*`, `resize`, `start`, `stop`, `reset`, `import`, `sql import`, `builds submit` | `list`, `describe`, `get-*`, `config list`, `auth list`, `projects list` | [gk] same caveat |
| az | `create`, `delete`, `update`, `set`, `add`, `remove`, `start`, `stop`, `restart`, `deployment ... create`, `role assignment create` | `list`, `show`, `get-*`, `account show`, `--what-if` on deployments | [gk] same caveat |
| flyctl (`fly`) | `deploy`, `launch`, `apps destroy`, `scale`, `secrets set/unset`, `machine run/update/destroy/stop`, `volumes create/destroy`, `postgres ...` writes, `certs add/remove`, `ips allocate/release` | `status`, `logs`, `releases`, `config show`, `config validate`, `apps list`, `secrets list` | [doc+gk] https://docs.fly.io/flyctl lists only deploy, launch, apps, secrets, logs, status, releases, ips, certs with no mutation labels |
| vercel | `deploy` (default command), `promote`, `rollback`, `redeploy`, `remove`, `env add/update/remove`, `domains add/remove/buy`, `dns add/remove`, `alias set/remove`, `certs issue/delete`, `project delete`, `buy`, `blob put/delete`, `cache purge`, `firewall ...`, `tokens create/revoke`, `integration add/remove`, `git connect/disconnect` | `list`, `inspect`, `logs`, `whoami`, `env list`, `env pull`, `pull` (writes local files), `dev`, `build`, `link` (local), `doctor`, `docs`, `health`, `billing` views | [doc] https://vercel.com/docs/cli (command descriptions); classification is mine. Note `vercel` with no subcommand is a deploy |
| wrangler | `deploy`, `delete`, `rollback`, `versions upload` (creates a version, no traffic), `versions deploy`, `secret put`, `secret delete`. Also (not fetched): `d1 execute --remote`, `d1 migrations apply --remote`, `kv key put/delete`, `r2 bucket delete` [gk] | `deployments list`, `tail`, `types` (local file), `dev` (local; `--remote` binds remote resources) | [doc] https://developers.cloudflare.com/workers/wrangler/commands/workers/ for the Workers rows; D1/KV/R2 rows [gk] |
| prisma | `migrate deploy`, `migrate dev` (dev DB), `migrate reset` (destructive, dev only; docs say agents are blocked without consent), `migrate resolve` (edits history table), `db push` (`--force-reset`, `--accept-data-loss`), `db execute` (any SQL), `db seed` | `migrate status`, `migrate diff`, `db pull` (writes `schema.prisma`; reads DB), `generate`, `validate`, `format` [gk for last three] | [doc] https://www.prisma.io/docs/orm/reference/prisma-cli-reference |
| drizzle-kit | `migrate`, `push` | `generate` (local files), `check`, `export`, `pull` (reads DB, writes local schema), `up` (local snapshots, not stated), `studio` (connects to DB for browsing; writes possible through its UI [gk]) | [doc] https://orm.drizzle.team/docs/kit-overview |
| knex | `migrate:latest`, `migrate:up`, `migrate:down`, `migrate:rollback`, `seed:run` | `migrate:status`, `migrate:list`, `migrate:currentVersion`, `migrate:make` (local file), `seed:make` | [gk] |
| alembic | `upgrade`, `downgrade`, `stamp` (edits version table) | `current`, `history`, `heads`, `branches`, `show`, `check`, `revision` (local file); `upgrade --sql` prints SQL, no DB write | [gk] |
| rails | `db:migrate`, `db:rollback`, `db:migrate:redo`, `db:schema:load`, `db:reset`, `db:drop`, `db:setup`, `db:seed`, `db:prepare` | `db:migrate:status`, `db:version`, `generate migration` (local file) | [gk] |
| django | `migrate`, `flush`, `loaddata`, `dbshell` (arbitrary SQL) | `showmigrations`, `sqlmigrate`, `makemigrations` (local files), `makemigrations --check`, `check`, `migrate --plan` | [gk] |
| psql / mysql | Anything that sends DDL or DML: `psql -c "<stmt>"`, `psql -f file.sql`, piped stdin, `\copy ... FROM`; same for `mysql -e`, `mysql < file`. Interactive sessions can run anything | `psql -c "SELECT ..."`, `\d`, `\dt`, `EXPLAIN` (without `ANALYZE` on writes), `--list`. No flag guarantees read-only; the Postgres setting `default_transaction_read_only=on` (e.g. via `PGOPTIONS`) and a read-only DB role do enforce it [gk] | [gk]. Text matching on SQL verbs (`INSERT UPDATE DELETE DROP ALTER TRUNCATE CREATE GRANT`) is easy to evade; a read-only role is the real stop |

Design consequences:
1. Match on tool plus subcommand allowlists of read-only forms where possible, since mutating verb lists keep growing. For the cloud CLIs, "read-only verb prefixes pass, everything else asks or denies" is safer than a deny list.
2. `vercel` alone, `terraform apply -auto-approve`, `fly deploy`, `kubectl apply -f -` are the common agent mistakes.
3. Read commands can still leak secrets (`aws ssm get-parameter --with-decryption`, `vercel env pull`, `kubectl get secret -o yaml`). That is a separate rule from mutation.

---

## Recommendations

| # | Item | Pick | Version (>= 2 weeks old) | License | Pin method | Notes |
|---|---|---|---|---|---|---|
| 1 | IaC scanner (S3) | Checkov | 3.4.0, 2026-10-28 | Apache-2.0 | PyPI `==` plus `--require-hashes`, or Docker digest | Trivy 0.76.1 is the fallback (checksums plus sigstore), but its March 2026 compromise argues against it as the default |
| 2 | Postgres migration linter (S5) | Squawk | 2.71.0, 2026-10-29 | Apache-2.0 | npm lockfile, or binary with a recorded sha256 | Postgres only. No free MySQL linter verified. Atlas lint rejected (Pro, login) |
| 3 | Rails / Django migration lint | strong_migrations 2.8.0 (2026-05-14, MIT); django-migration-linter v6.0.0 (2026-01-04, Apache-2.0) | as stated | as stated | Gemfile.lock; pip hashes | Optional, framework gated |
| 4 | JS dependency audit (S4) | `npm audit`, `pnpm audit`, `yarn npm audit` | built in | n/a | n/a | No new binary |
| 5 | Other-language audit | pip-audit 2.10.1 (2026-06-10); govulncheck 1.9.0 (2026-10-11); cargo-audit 0.22.2 (2026-06-05); bundler-audit 0.9.3 (2025-11-28, GPL-3.0) | as stated | Apache-2.0; BSD-3-Clause; Apache-2.0 OR MIT; GPL-3.0 | pip hashes; Go sumdb; `--locked`; gem version | bundler-audit needs an owner license decision |
| 6 | Cross-ecosystem audit | OSV-Scanner | 2.7.0, 2026-10-12 | Apache-2.0 | `osv-scanner_SHA256SUMS` plus SLSA provenance | Best verification story |
| 7 | Secrets (S1, S2) | Gitleaks | 8.30.1, 2026-03-21 | MIT | `gitleaks_8.30.1_checksums.txt`, sha256 in plan matches | Hook `gitleaks-system` plus CI binary job. No action |
| 8 | Official plugins (B4 to B6) | terraform (HashiCorp), aws-core, deploy-on-aws, azure, cloud-sql-postgresql, neon, supabase, prisma, cloudflare, vercel, netlify-skills, railway, render | marketplace-pinned shas | per plugin (not checked, except terraform-mcp-server MPL-2.0) | marketplace entry sha | Kubernetes: registry-only MCP server v0.1.1. Pulumi, Fly, general GCP, general Postgres: unverified |
| 9 | Guard signals (S6) | Section 6 tables | n/a | n/a | n/a | Owner rules on the cloud-CLI coverage mapping |

---

## Open questions

1. Checkov hashes: does the owner accept harness generating a hashed requirements file per pinned version (needs a pip install at catalog time), or prefer a Docker digest pin?
2. Is a Trivy-based option acceptable at all after the March 2026 compromise, or is it excluded until the owner re-reviews?
3. KICS: the Wiz-reported `kics-github-action` compromise is UNVERIFIED from a Checkmarx source. Worth one more lookup before KICS is even listed as an alternative.
4. bundler-audit is GPL-3.0. Allow it as an optional item with a license note, or leave Ruby on `bundle audit` guidance text only?
5. MySQL migration linting: leave uncovered with a stated reason, or research further (for example Skeema, not looked at here)?
6. Alembic migrations are Python, so Squawk misses them. Accept the gap or document the `alembic upgrade --sql` pipeline?
7. Cloud CLI coverage rule (6.1): is "any IaC file for that cloud present means deny `aws`/`gcloud`/`az` writes" the intended granularity?
8. MCP servers (Terraform, Kubernetes, cloud databases) can mutate infrastructure through tool calls the Bash guard never sees. Should the guard or the catalog stance cover MCP tool names too?
9. The marketplace `terraform` plugin pins HashiCorp server 0.4.0 while upstream is at v1.4.1. Recommend it as is, or note the gap?
10. Several [gk] rows in 6.2 (aws, gcloud, az, knex, alembic, rails, django, psql/mysql, cdk) were not checked against a doc this session. Verify before they become guard rules.
11. Gitleaks: the full commit sha for tag v8.30.1 still has to be looked up when the template is written.

## Rulings (2026-11-13)
- Q1, owner: Checkov is pinned through pip with a hashed requirements file that harness generates for each pinned version (the require-hashes mode).
- Q2: Trivy is excluded because of the March 2026 compromise. It needs a re-review before it can come back.
- Q3: KICS is not listed until a Checkmarx source confirms the action compromise is resolved.
- Q4: bundler-audit is an optional item, with a GPL-3.0 note.
- Q5: MySQL migration linting is a documented gap. Skeema gets researched later.
- Q6: the Alembic gap is documented, along with the `alembic upgrade --sql` route.
- Q7, owner: coverage is per cloud. Any IaC for that cloud blocks all write commands for its CLI and points to the IaC.
- Q8, owner: harness guards MCP tool calls too. Write-capable infra tools are denied unattended and asked when attended, under the same IaC rule. Read-only tools pass, and unknown tools from an infra server ask.
- Q9: recommend the terraform plugin, and note its version gap.
- Q10: every general-knowledge row is checked against vendor docs before it becomes a guard rule.
- Q11: the sha is looked up when the gitleaks template is written.
