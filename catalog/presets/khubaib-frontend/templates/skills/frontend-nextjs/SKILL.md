---
name: frontend-nextjs
description: 'Next.js rules for this repo (Server Components first, "use client" at the smallest leaf, loading.tsx and error.tsx, next/image, SEO). Use when working on Next.js routes, layouts or data loading.'
---
# Frontend Next.js

Next.js rules for this repo. The shared React rules are in `frontend-react`.

## Server and client

- Server Components by default.
- Put `"use client"` at the smallest leaf.
- Load the first view's data in Server Components. Use TanStack Query on the client for interactive and live data.
- Import `server-only` in modules with server-only code. A client import then fails at build time. [docs: https://nextjs.org/docs/app/getting-started/server-and-client-components]
- Only `NEXT_PUBLIC_` env vars reach the client bundle, so a secret never gets that prefix. [docs: https://nextjs.org/docs/app/getting-started/server-and-client-components]

## Loading and errors

- Use Suspense, `loading.tsx` and `error.tsx`.
- Add `loading.tsx` to dynamic routes. It enables partial prefetching and shows a loading UI at once. [docs: https://nextjs.org/docs/app/getting-started/linking-and-navigating]

## Images, links and fonts

- Use the next Image component, not a raw `<img>`.
- Use `next/link`, not a raw `<a>`, for internal routes. `<Link>` prefetches them. [docs: https://nextjs.org/docs/app/getting-started/linking-and-navigating]
- Load fonts with `next/font`. It self-hosts them with no layout shift. [docs: https://nextjs.org/docs/app/getting-started/fonts]

## SEO

- Web apps are "SEO-optimized from the start, with a focus on performance and ideal UX best practices".
- Set page metadata with the metadata API.

## Testing

- E2E tests use Playwright, for key flows only.

## Anti-patterns

Client creep:
- No `"use client"` high in the tree.
- No client components only to fetch data.
- No server-only code or secrets in client bundles.

Data waterfalls:
- No client-effect fetching the server could do.

Caching mistakes:
- No wrong or implicit cache and revalidate settings.
- Revalidate after every mutation.
- After a mutation in a Server Function, call `revalidatePath` or `revalidateTag`. [docs: https://nextjs.org/docs/app/getting-started/mutating-data]
- No route handlers where server actions fit.

Asset and SEO misses:
- No raw `<img>` or `<a>`.
- No page without the metadata API.
- No layout shift.
