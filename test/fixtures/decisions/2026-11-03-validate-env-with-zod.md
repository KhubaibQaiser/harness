---
schema: harness-decision/1
id: 2026-11-03-validate-env-with-zod
title: Validate env with zod
status: active
paths:
  - "src/env/**"
  - "src/config.ts"
verified_at: 4f0c2a9e1b7d3c5a6e8f0a1b2c3d4e5f6a7b8c9d
verified_on: 2026-11-03
---
**Rule:** Parse every environment variable through `src/env/schema.ts`; never read `process.env` elsewhere.

**Why:** Two outages came from typos in env names that nothing checked.
