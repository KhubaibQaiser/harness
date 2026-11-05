/** Catalog id -> the environment variable that turns its telemetry off. */
export const TELEMETRY_ENV: Record<string, { name: string; value: string }> = {
  // catalog/items/impeccable.yaml evidence: README Telemetry section, "DO_NOT_TRACK=1".
  impeccable: { name: 'DO_NOT_TRACK', value: '1' },
  // obra/superpowers@2ce8aa15 README.md line 400 says "any true value"; skills/brainstorming/scripts/server.cjs
  // lines 107-112 and 227-232 treat anything but empty, 0, false, no or off as true. 'true' is what its tests use (owner ruling).
  superpowers: { name: 'SUPERPOWERS_DISABLE_TELEMETRY', value: 'true' },
};
