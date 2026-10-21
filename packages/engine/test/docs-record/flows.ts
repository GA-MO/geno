export type { Flow, Recording } from './kit.js';
import { BASE } from './flows-base.js';
import { HOOKS } from './flows-hooks.js';
import { BG } from './flows-bg.js';
import { TOOLS } from './flows-tools.js';
import { ERRORS } from './flows-errors.js';
import { MISC } from './flows-misc.js';
import { EXT } from './flows-ext.js';

// A new batch of flows is a new flows-<name>.ts file that imports only from kit.ts, added to this list.
export const FLOWS = [...BASE, ...HOOKS, ...BG, ...TOOLS, ...ERRORS, ...MISC, ...EXT];
