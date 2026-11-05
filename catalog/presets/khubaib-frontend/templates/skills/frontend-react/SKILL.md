---
name: frontend-react
description: 'Shared React architecture rules for this repo (folders, state, components, forms, server data, testing, UI states, performance, style, accessibility, env). Use when writing or reviewing React code.'
---
# Frontend React

Shared React rules for this repo. The Next.js and React Native rules live in their own skills.

## Folders

- Hybrid layout. Shared and generic code goes by type: `_components/`, `hooks/`, `lib/`.
- Product features go by feature.

## State

- Client state, in the owner's words: "Filters, tabs and pagination goes to URL search params, local state where its only needed for single component and should reset on unmount, context for ready only shared/global level state, zustand with carefully curated slices for optimized performance"

## Server data and the API layer

- Use TanStack Query on the client for interactive and live data.
- Use a typed client, generated from OpenAPI or with Zod-parsed responses.
- Each feature has its own query and mutation hooks, with key factories.
- Components only use the hooks.

## Components

- Use the in-house design-system components, built on headless primitives.
- Style them with Tailwind and variants (cva).
- No raw styling inside features.
- Tailwind: don't use hardcoded classes like `h-[98px]`. Use the closest built-in or breakpoint class instead, for a more responsive design.

## Forms

- Use React Hook Form with Zod schemas.
- The Zod schema is the single validation source, shared with the server.
- Fields use the design-system wrappers.

## UI states

- Wrap widgets in error boundaries with a retry.
- Give every list an explicit empty state.

## Testing

- Unit tests use Testing Library. Test behaviour, and query by role.
- Mock APIs with MSW.
- Write E2E tests only for key flows.
- Design-system components get Storybook stories and visual tests.

## Performance

- Structure first: colocate state, lift content up as `children`, use narrow selectors and split contexts.
- With the React Compiler on, rely on it and skip manual memo.
- Use narrow store selectors.
- Virtualize long lists.
- In plain React, use lazy loading and similar techniques.

## Style

- kebab-case files, PascalCase components.
- Hooks are camelCase and start with `use`.
- Named exports only, except where the framework needs a default.
- Strict TypeScript: no `any`, a justified `!`, Zod-inferred types.
- Barrel files only at a feature's or design system's public edge.

## Accessibility and env

- Accessibility baseline: semantic HTML, labels, keyboard and focus, WCAG AA.
- Validate env vars once with Zod in `env.ts`. Outside `env.ts`, never read `process.env` directly.

## Anti-patterns

useEffect misuse:
- No syncing props to state.
- No fetching in effects.
- No effect chains.
- To reset a component's state when a prop changes, give it a `key`. Don't reset it in an effect. [docs: https://react.dev/learn/you-might-not-need-an-effect]

Prop drilling and bloat:
- No props passed through many layers.
- No oversized props.
- No boolean prop soup.

Key and state bugs:
- No index keys in dynamic lists.
- No state for values you can compute.
- No server data in Zustand.
