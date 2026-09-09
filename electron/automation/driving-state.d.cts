// Hand-written declarations for driving-state.cjs, so the vitest suite under
// src/ can import the real module instead of testing a copy. Nothing compiles
// electron/, so these are maintained beside the implementation -- change one,
// change the other. Same contract as progress.d.cts and redact.d.cts.

export const FILE_NAME: string;
export const TTL_MS: number;
export const HEARTBEAT_MS: number;
export const AI_IDLE_MS: number;
export const MAX_LABEL: number;

/** What is written into a profile's scout-automation.json, and what the browser
 *  fork's ScoutAutomationState parses. `active` is always true when the file
 *  exists -- idle is the file's ABSENCE, so there is one way to say it. */
export interface DrivingStateFile {
  active: true;
  kind: 'automation' | 'ai';
  /** The automation's name, capped at MAX_LABEL. Empty for `ai`. */
  label: string;
  /** Absolute epoch ms. A file past this is stale and must read as inactive. */
  expiresAt: number;
}

export interface DrivingState {
  AI_IDLE_MS: number;
  FILE_NAME: string;
  HEARTBEAT_MS: number;
  TTL_MS: number;
  /** A run started, or logged a step. Idempotent; refreshes `expiresAt` and
   *  arms the heartbeat that keeps refreshing it for as long as the run lasts,
   *  including through a single step longer than TTL_MS. */
  runActive(profileId: string, label?: string): void;
  /** An AI/MCP tool touched this profile. Ignored while a run owns the window. */
  aiActive(profileId: string): void;
  /** The run ended, the window closed, or the profile is relaunching. */
  idle(profileId: string): void;
  /** Every profile this process marked, cleared. For quit. */
  idleAll(): void;
}

export function createDrivingState(options: {
  /** Profile id to its user-data-dir, or '' when there is none. */
  resolveUserDataDir: (profileId: string) => string;
  now?: () => number;
}): DrivingState;
