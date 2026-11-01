export type BackgroundCommandId = 'copy' | 'move' | 'zip-pack' | 'zip-unpack' | 'zip-test' | 'zip-update';
export type CommandId = BackgroundCommandId | 'delete' | 'rename' | 'rename-many' | 'mkdir' | 'new-file';
export interface BackgroundSupport {
  readonly enabled: true;
  readonly execution: { readonly isolation: 'exclusive' };
  readonly selection: { readonly minItems: 0 | 1 };
  readonly progress: { readonly required: true; readonly contractVersion: 1 };
  readonly cancellation: { readonly mode: 'cooperative' | 'between-roots' };
  readonly presentation: { readonly placement: 'pane-header' };
}
export interface ForegroundSupport {
  readonly enabled: false;
  readonly reason: 'foreground-only';
  readonly presentation: { readonly progress: 'footer'; readonly interaction: 'locked' };
}
export type CommandRegistry = {
  readonly [Id in CommandId]: {
    readonly id: Id;
    readonly supportsBackgroundOperation: Id extends BackgroundCommandId ? BackgroundSupport : ForegroundSupport;
  };
};
export interface OperationInput {
  readonly command: BackgroundCommandId;
  readonly title: string;
  readonly target: string;
  readonly sources: readonly string[];
  readonly label?: string;
  readonly targetLocation?: { readonly pane: 0 | 1; readonly tabId: string };
}
export interface OperationRequest extends OperationInput { readonly version: 1 }
export interface Job {
  readonly id: string;
  readonly request: OperationRequest;
  readonly command: CommandRegistry[BackgroundCommandId];
  state: 'waiting' | 'running';
  cancelling?: boolean;
  started?: number;
  progress?: import('./commander-progress').StatusSnapshot;
  currentPath?: string;
  control?: HTMLElement;
  run?: (job: Job) => unknown;
}
export const commands: CommandRegistry;
export type ActionCommands = Readonly<Record<string, CommandId>>;
export const actionCommands: ActionCommands;
export const executionPolicy: { readonly mode: 'serial'; readonly maxConcurrent: 1 };
export function getCommand<Id extends CommandId>(id: Id): CommandRegistry[Id];
export function commandForAction(action: string): CommandRegistry[CommandId] | null;
export function operation(input: OperationInput): OperationRequest;
export function createQueue(options: {
  start(job: Job): void;
  finish(job: Job, result: { ok?: boolean; cancelled?: boolean; error?: string; message?: string }): void;
  cancel?(job: Job): void;
  change?(): void;
}): {
  readonly items: Job[];
  readonly active: Job | null;
  add(request: OperationInput, run?: (job: Job) => unknown): Job;
  complete(id: string, result: { ok?: boolean; cancelled?: boolean; error?: string; message?: string }): void;
  cancel(id: string): void;
  dispose(): void;
};

export function summarize(items: readonly Job[]): { current: number | null; overall: number | null };
