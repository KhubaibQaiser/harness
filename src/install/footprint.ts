import { measureSelectionSync } from '../budget/measure.js';
import type { Catalog } from '../catalog/schema.js';
import { LEGACY_OWN } from './plan.js';

/** Always-loaded tokens of the default install: the plugin plus the legacy own items. */
export const footprint = (dirs: { templates: string; plugin: string }, c: Catalog): number => measureSelectionSync(LEGACY_OWN, c, dirs).tokens;
