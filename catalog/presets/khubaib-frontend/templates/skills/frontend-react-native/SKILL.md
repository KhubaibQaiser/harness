---
name: frontend-react-native
description: 'React Native rules for this repo (Expo dev builds, Expo Router, expo-image, FlashList, Reanimated, config plugins). Use when working on React Native or Expo screens, lists or native config.'
---
# Frontend React Native

React Native and Expo rules for this repo. The shared React rules are in `frontend-react`.

## Stack

- Expo with dev builds.
- Expo Router for navigation.
- expo-image for images.
- FlashList for lists.
- Reanimated for animation.
- Change native config through config plugins. Never eject.
- Prebuild generates `ios/` and `android/`. Hand edits there can be lost. [docs: https://docs.expo.dev/workflow/continuous-native-generation/]

## Server data

- Use TanStack Query.

## Env

- Only `EXPO_PUBLIC_` vars reach the app, in plain text in the bundle. Never put a secret in one. [docs: https://docs.expo.dev/guides/environment-variables/]
- In `env.ts`, read each one as `process.env.EXPO_PUBLIC_NAME`. Destructuring and bracket access aren't inlined. [docs: https://docs.expo.dev/guides/environment-variables/]

## Accessibility and platform

- Use the RN accessibility props.
- Handle safe areas with `react-native-safe-area-context`: `SafeAreaView` or `useSafeAreaInsets`. [docs: https://docs.expo.dev/develop/user-interface/safe-areas/]

## Testing

- E2E tests use Maestro or Detox, for key flows only.

## Anti-patterns

List misuse:
- No ScrollView or `map` for long lists.
- No FlatList where FlashList fits.
- No unstable keys or inline `renderItem`.

JS-thread animation:
- Animate with Reanimated worklets, not state or timers.
- No heavy JS work during gestures.

Native workflow drift:
- No hand-edited `ios/` or `android/`.
- No ejecting.
- No Expo Go-only assumptions.

Platform blind spots:
- Don't ignore safe areas or font scaling.
- No missing accessibility props.
- No web-only APIs in shared code.
