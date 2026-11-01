export type ProgressUnit = 'bytes' | 'items' | 'requests' | 'steps';
export type UnknownReason = 'enumerating' | 'stream-size-unknown' | 'native-operation' | 'awaiting-confirmation';
export type Measurement =
  | { readonly kind: 'determinate'; readonly unit: ProgressUnit; readonly completed: number; readonly total: number }
  | { readonly kind: 'indeterminate'; readonly unit: ProgressUnit; readonly completed: number; readonly reason: UnknownReason };
export type DeterminateMeasurement = Extract<Measurement, { kind: 'determinate' }>;
export type IndeterminateMeasurement = Extract<Measurement, { kind: 'indeterminate' }>;
export interface ProgressInput {
  readonly phase: string;
  readonly overall: Measurement;
  readonly current: Measurement;
  readonly [field: string]: unknown;
}
export interface ProgressEvent extends ProgressInput { readonly version: 1 }
export function known(unit: ProgressUnit, completed: number, total: number): DeterminateMeasurement;
export function unknown(unit: ProgressUnit, completed: number, reason: UnknownReason): IndeterminateMeasurement;
export function event(input: ProgressInput): ProgressEvent;
export function read(input: unknown): ProgressEvent;
declare const statusSnapshot: unique symbol;
export interface StatusSummary {
  readonly id: string;
  readonly totalSteps: number;
  readonly completedSteps: number;
  readonly failedSteps: number;
  readonly openPlanningCount: number;
  readonly done: boolean;
  readonly state: 'running' | 'complete' | 'error' | 'cancelled';
  readonly activeStepId: string | null;
}
export interface StatusAnalysis extends StatusSummary {
  readonly openPlanning: readonly string[];
  readonly steps: readonly { readonly id: string; readonly parent: string | null; readonly state: 'pending' | 'running' | 'complete' | 'error'; readonly error: string | null; readonly startedAt: number | null; readonly finishedAt: number | null; readonly children: readonly string[]; readonly measurement: ProgressEvent | null; readonly range: { readonly total: number; readonly completed: number } | null }[];
}
export interface StatusSnapshot extends ProgressEvent {
  readonly [statusSnapshot]: true;
  readonly id: string;
  readonly startedAt: number;
  readonly plan: StatusSummary;
  readonly display: { readonly overallPercent: number | null; readonly currentPercent: number | null };
}
export interface TerminalStatusSnapshot extends StatusSnapshot {
  readonly plan: StatusSummary & { readonly state: 'complete' | 'error' | 'cancelled' };
}
export type StatusActivity = StatusSnapshot | null;
export interface StatusPlan {
  openPlanning(step: string): void;
  closePlanning(step: string): void;
  append(parent: string | null, steps: readonly string[]): readonly string[];
  reserve(parent: string, total: number): void;
  confirmRange(parent: string, completed: number): void;
  analyze(): StatusAnalysis;
  start(step: string): void;
  complete(step: string): void;
  fail(step: string, error: string): void;
  update(step: string, progress: ProgressEvent): void;
  terminate(outcome: 'error' | 'cancelled'): void;
  snapshot(): StatusSnapshot;
  finishedSnapshot(): TerminalStatusSnapshot;
}
export function statusPlan(input: { id: string; startedAt: number; steps: readonly string[]; mode?: 'steps' | 'work' }): StatusPlan;
export function readStatus(input: unknown): StatusSnapshot;
export function readFinishedStatus(input: unknown): TerminalStatusSnapshot;
export function statusReport(input: StatusSnapshot): { readonly plan: StatusAnalysis; readonly omittedEvents: number; readonly events: readonly { readonly action: string; readonly step: string | null; readonly timestamp: string; readonly elapsedMs: number; readonly [field: string]: unknown }[] };
export interface StatusProgressInput {
  readonly progress: StatusSnapshot;
  readonly title: string;
  readonly statusTitle?: string;
  readonly statusPath?: string;
  readonly quiet?: boolean;
  readonly overallValueText?: string;
  readonly fileValueText?: string;
  readonly element?: Element;
  readonly modal?: boolean;
  readonly cancelRequested?: boolean;
  readonly cancelAvailable?: boolean;
}
export interface StatusFinishInput {
  readonly progress: TerminalStatusSnapshot;
  readonly message?: string;
  readonly severity?: unknown;
  readonly outcome?: string;
}
export interface Statusbar {
  readonly version: number;
  setProgress(input: StatusProgressInput): void;
  setActivity(message: string, progress: StatusActivity): void;
  finishProgress(input: StatusFinishInput): void;
  setStatus(message: string, outcome?: string): void;
  notify(message: string, severity?: unknown, id?: string): unknown;
  success(message: string): void;
  error(message: string): unknown;
  reset(): void;
  dispose(): void;
}
declare global {
  interface Window {
    CommanderStatusbar: { create(input: Record<string, unknown>): Statusbar };
    CommanderWorkbench: { readonly Severity: Readonly<Record<string, number>> };
  }
}
