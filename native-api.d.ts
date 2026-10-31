export type NativeOperation =
  | 'files.copy' | 'files.rename'
  | 'clipboard.readFiles' | 'clipboard.writeFiles' | 'clipboard.acknowledge'
  | 'shell.showContextMenu' | 'shell.openAssociated' | 'shell.openTrash' | 'shell.openTerminal'
  | 'icons.resolve' | 'metadata.query' | 'paths.resolveNetwork'
  | 'encoding.describe' | 'encoding.decodeBlock' | 'encoding.decodeChunk'
  | 'windows.resolveOwner' | 'windows.maximize'
  | 'locks.scan' | 'locks.releaseHandles' | 'locks.unloadModules' | 'locks.rename'
  | 'processes.terminate' | 'restartDeletion.prepare' | 'restartDeletion.commit'
  | 'git.status' | 'git.info';

export interface NativeCapability {
  readonly status: 'supported' | 'conditional' | 'unsupported';
  readonly reason?: string;
  readonly maxBytes?: number;
}

export interface NativeMetadata {
  readonly provenance: 'win32.fileAttributes';
  readonly attributes: Readonly<Record<
    'readonly' | 'hidden' | 'system' | 'directory' | 'archive' | 'compressed' | 'encrypted', boolean>>;
}

export interface NativeCompletion {
  readonly requestId: bigint;
  readonly generation: bigint;
}

export interface NativeCodepage {
  readonly codepage: number;
  readonly maxCharSize: number;
  readonly name: string;
  readonly blockDecoding: boolean;
}

export interface NativeDecodeRequest {
  readonly codepage: number;
  readonly bytes: Buffer;
  readonly offset?: number;
  readonly textOnly?: boolean;
}

export interface NativeDecodedBlock {
  readonly text: string;
  readonly encoding: string;
  readonly map?: readonly number[];
}

export interface NativeDecodeChunkRequest extends NativeDecodeRequest {
  readonly pending: Buffer;
  readonly final: boolean;
  readonly mapStart: number;
}

export interface NativeDecodedChunk extends NativeDecodedBlock {
  readonly pending: Buffer;
  readonly mapStart: number;
}

export interface NativeNetworkMappings {
  readonly mappings: Readonly<Record<string, string | null>>;
}

export type NativeClipboardMode = 'copy' | 'move';

export interface NativeClipboardSelection {
  readonly paths: readonly string[];
  readonly mode: NativeClipboardMode;
  readonly token: string;
}

export interface NativeClipboardWriteRequest {
  readonly paths: readonly string[];
  readonly mode: NativeClipboardMode;
}

export interface NativeClipboardAcknowledgeRequest extends NativeClipboardWriteRequest {
  readonly token: string;
  readonly remainingPaths: readonly string[];
}

export interface NativeClipboardAcknowledgeResult {
  readonly matched: boolean;
  readonly notificationErrors: readonly string[];
}

export interface NativeGitStatusEntry {
  readonly path: string;
  readonly flags: number;
  readonly conflicted: boolean;
  readonly ignored: boolean;
}

export interface NativeGitStatusProgress extends NativeCompletion {
  readonly path: string;
}

export interface NativeGitStatusResult {
  readonly ok: boolean;
  readonly repository: boolean;
  readonly root?: string;
  readonly gitdir?: string;
  readonly branch?: string | false;
  readonly head?: string;
  readonly detached?: boolean;
  readonly unborn?: boolean;
  readonly entries: readonly NativeGitStatusEntry[];
  readonly indexVersion?: number;
  readonly skipWorktree?: boolean;
  readonly sparseCheckout?: boolean;
  readonly autocrlf?: string;
  readonly names?: readonly string[];
  readonly remoteNames?: readonly string[];
  readonly count?: number;
  readonly otherCount?: number;
}

export interface NativeCaseRenameRequest {
  readonly source: string;
  readonly target: string;
  readonly roots: readonly string[];
  readonly expected: Readonly<Record<'dev' | 'ino' | 'size' | 'mtimeNs' | 'ctimeNs', string>>;
}

export interface NativeRenameOutcome {
  readonly status: 'committed' | 'unchanged';
  readonly renamed: boolean;
}

export interface NativeFileIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

export interface NativeCopyRequest {
  readonly source: string;
  readonly target: string;
  readonly roots: readonly string[];
  readonly expected: NativeFileIdentity;
}

export interface NativeCopyOutcome {
  readonly status: 'committed' | 'unchanged' | 'partial' | 'unknown';
  readonly copied: boolean;
  readonly cancelled: boolean;
  readonly ownedDestination?: NativeFileIdentity;
}

export interface NativeCopyProgress {
  readonly transferred: number;
  readonly total: number;
  readonly ownedDestination?: NativeFileIdentity;
}

export interface NativeCopyOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: NativeCopyProgress & NativeCompletion) => void;
}

export interface NativeIconRequest {
  readonly key: string;
  readonly path?: string;
  readonly name?: string;
  readonly type: 'file' | 'folder';
  readonly iconResource?: string;
}

export interface NativeIcons {
  readonly icons: readonly { readonly key: string; readonly png: Buffer | null }[];
}

export interface NativeAssociationRequest {
  readonly path: string;
  readonly inspectOnly?: boolean;
}

export interface NativeAssociationResult {
  readonly editor: boolean;
  readonly available?: boolean;
  readonly requested?: boolean;
  readonly outcome?: NativeDesktopOutcome;
}

export interface NativeShellMenuRequest {
  readonly mode: 'inspect' | 'show';
  readonly paths: readonly string[];
  readonly roots: readonly string[];
  readonly keyboard?: boolean;
  readonly ownerTitle?: string;
  readonly lockInspectionLabel?: string;
}

export interface NativeShellMenuResult {
  readonly ok: true;
  readonly displayed: boolean;
  readonly invoked: boolean;
  readonly cancelled: boolean;
  readonly entries: readonly { readonly label: string; readonly verb: string; readonly submenu: boolean }[];
  readonly interfaces: { readonly contextMenu2: boolean; readonly contextMenu3: boolean };
  readonly action?: 'inspect-locks';
  readonly timing: { readonly nativeMilliseconds: number };
}

export interface NativeTrashView { readonly available: boolean; readonly requested: boolean; readonly outcome?: NativeDesktopOutcome }

export interface NativeDesktopOutcome {
  readonly status: 'unchanged' | 'unknown' | 'committed';
  readonly requested: boolean;
}

export interface NativeLockRow {
  readonly pid: number;
  readonly started: string;
  readonly name?: string;
  readonly executable?: string;
  readonly commandLine?: string;
  readonly file: string;
  readonly kind: 'handle' | 'image' | 'module';
  readonly handle?: string;
  readonly module?: string;
  readonly canTerminate?: boolean;
  readonly terminationReason?: string;
}

export interface NativeLockResult {
  readonly rows: readonly NativeLockRow[];
  readonly inaccessible: number;
  readonly changed: number;
  readonly errors: readonly string[];
  readonly backup: string;
  readonly token: string;
  readonly outcome?: NativeLockOutcome | 'committed';
}

export interface NativeLockMutationRequest {
  readonly path: string;
  readonly hostPid: number;
  readonly rows: readonly NativeLockRow[];
}

export interface NativeLockRenameRequest {
  readonly path: string;
  readonly destination: string;
  readonly expected: Pick<NativeFileIdentity, 'dev' | 'ino'>;
  /** Identity of the destination directory. */
  readonly expectedParent: Pick<NativeFileIdentity, 'dev' | 'ino'>;
}

export interface NativeRestartDeletionOutcome {
  readonly status: 'unchanged' | 'partial' | 'unknown' | 'committed';
  readonly queuedCount: number;
  readonly backup: string;
}

export interface NativeRestartDeletionResult extends NativeLockResult {
  readonly queuedCount: number;
  readonly outcome: 'committed';
}

export interface NativeOperationError extends Error {
  readonly code: string;
  readonly operation?: NativeOperation;
  readonly nativeCode?: number;
  readonly nativeDomain?: string;
  readonly requestId?: bigint;
  readonly generation?: bigint;
  readonly outcome?: NativeRenameOutcome | NativeCopyOutcome | NativeRestartDeletionOutcome | NativeLockOutcome | NativeDesktopOutcome;
  readonly ownedDestination?: NativeFileIdentity;
  readonly backup?: string;
  readonly changed?: number;
  readonly queuedCount?: number;
}

export interface NativeLockOutcome {
  readonly status: 'unchanged' | 'partial' | 'unknown' | 'committed';
  readonly changed: number;
  readonly signalled?: number;
}

export interface NativeSession {
  readonly generation: bigint;
  invoke(operation: 'locks.scan', request: { readonly path: string }): Promise<NativeLockResult & NativeCompletion>;
  invoke(operation: 'locks.releaseHandles' | 'locks.unloadModules' | 'processes.terminate', request: NativeLockMutationRequest): Promise<NativeLockResult & NativeCompletion>;
  invoke(operation: 'locks.rename', request: NativeLockRenameRequest): Promise<NativeLockResult & NativeCompletion>;
  invoke(operation: 'restartDeletion.prepare', request: { readonly path: string; readonly backup: string }): Promise<NativeLockResult & NativeCompletion>;
  invoke(operation: 'restartDeletion.commit', request: { readonly path: string; readonly backup: string; readonly token: string }): Promise<NativeRestartDeletionResult & NativeCompletion>;
  invoke(operation: 'metadata.query', request: { readonly path: string }): Promise<NativeMetadata & NativeCompletion>;
  invoke(operation: 'files.copy', request: NativeCopyRequest, options?: NativeCopyOptions): Promise<NativeCopyOutcome & NativeCompletion>;
  invoke(operation: 'icons.resolve', request: { readonly requests: readonly NativeIconRequest[] }): Promise<NativeIcons & NativeCompletion>;
  invoke(operation: 'shell.openAssociated', request: NativeAssociationRequest): Promise<NativeAssociationResult & NativeCompletion>;
  invoke(operation: 'shell.showContextMenu', request: NativeShellMenuRequest): Promise<NativeShellMenuResult & NativeCompletion>;
  invoke(operation: 'shell.openTerminal', request: { readonly path: string; readonly inspectOnly?: boolean }): Promise<{ readonly requested: boolean; readonly parameters: string } & NativeCompletion>;
  invoke(operation: 'shell.openTrash', request: { readonly inspectOnly?: boolean }): Promise<NativeTrashView & NativeCompletion>;
  invoke(operation: 'windows.maximize', request: { readonly titleToken: string }): Promise<{ readonly maximized: true } & NativeCompletion>;
  invoke(operation: 'files.rename', request: NativeCaseRenameRequest): Promise<NativeRenameOutcome & NativeCompletion>;
  invoke(operation: 'paths.resolveNetwork', request: { readonly drives: readonly string[] }): Promise<NativeNetworkMappings & NativeCompletion>;
  invoke(operation: 'clipboard.readFiles', request: Record<string, never>): Promise<NativeClipboardSelection & NativeCompletion>;
  invoke(operation: 'clipboard.writeFiles', request: NativeClipboardWriteRequest): Promise<NativeClipboardSelection & NativeCompletion>;
  invoke(operation: 'clipboard.acknowledge', request: NativeClipboardAcknowledgeRequest): Promise<NativeClipboardAcknowledgeResult & NativeCompletion>;
  invoke(operation: 'git.status', request: { readonly directory: string; readonly scope: string; readonly recursive?: boolean; readonly showIgnored?: boolean; readonly includeScopes?: readonly string[]; readonly excludeScopes?: readonly string[] }, options?: { readonly signal?: AbortSignal; readonly onProgress?: (event: NativeGitStatusProgress) => void }): Promise<NativeGitStatusResult & NativeCompletion>;
  invoke(operation: 'git.info', request: { readonly directory: string }, options?: { readonly signal?: AbortSignal }): Promise<NativeGitStatusResult & NativeCompletion>;
  invoke(operation: 'encoding.describe', request: { readonly codepage: number }): Promise<NativeCodepage & NativeCompletion>;
  invoke(operation: 'encoding.decodeBlock', request: NativeDecodeRequest): Promise<NativeDecodedBlock & NativeCompletion>;
  invoke(operation: 'encoding.decodeChunk', request: NativeDecodeChunkRequest): Promise<NativeDecodedChunk & NativeCompletion>;
  close(): void;
  closeAsync(): Promise<void>;
}

export interface NativeApi {
  readonly apiVersion: { readonly major: 1; readonly minor: number };
  readonly capabilities: Readonly<Record<NativeOperation, NativeCapability>>;
  openSession(): NativeSession;
  shutdown(): void;
  shutdownAsync(): Promise<void>;
}

export interface NativeBinding {
  readonly apiVersion: { readonly major: number; readonly minor: number };
  readonly capabilities: Partial<Readonly<Record<NativeOperation, NativeCapability>>>;
  openSession(): {
    readonly generation: bigint;
    invoke(operation: 'metadata.query', request: { readonly path: string }): Promise<NativeMetadata>;
    invoke(operation: 'files.copy', request: NativeCopyRequest, progress?: (event: NativeCopyProgress) => void): Promise<NativeCopyOutcome> & { cancel(): void; cancelIo(): void };
    invoke(operation: 'icons.resolve', request: { readonly requests: readonly NativeIconRequest[] }): Promise<NativeIcons>;
    invoke(operation: 'shell.openAssociated', request: NativeAssociationRequest): Promise<NativeAssociationResult>;
    invoke(operation: 'shell.showContextMenu', request: NativeShellMenuRequest): Promise<NativeShellMenuResult>;
    invoke(operation: 'shell.openTerminal', request: { readonly path: string; readonly inspectOnly?: boolean }): Promise<{ readonly requested: boolean; readonly parameters: string }>;
    invoke(operation: 'shell.openTrash', request: { readonly inspectOnly?: boolean }): Promise<NativeTrashView>;
    invoke(operation: 'windows.maximize', request: { readonly titleToken: string }): Promise<{ readonly maximized: true }>;
    invoke(operation: 'files.rename', request: NativeCaseRenameRequest): Promise<NativeRenameOutcome>;
    invoke(operation: 'paths.resolveNetwork', request: { readonly drives: readonly string[] }): Promise<NativeNetworkMappings>;
    invoke(operation: 'clipboard.readFiles', request: Record<string, never>): Promise<NativeClipboardSelection>;
    invoke(operation: 'clipboard.writeFiles', request: NativeClipboardWriteRequest): Promise<NativeClipboardSelection>;
    invoke(operation: 'clipboard.acknowledge', request: NativeClipboardAcknowledgeRequest): Promise<NativeClipboardAcknowledgeResult>;
    invoke(operation: 'git.status', request: { readonly directory: string; readonly scope: string; readonly recursive?: boolean; readonly showIgnored?: boolean; readonly includeScopes?: readonly string[]; readonly excludeScopes?: readonly string[] }, progress?: (event: { readonly path: string }) => void): Promise<NativeGitStatusResult> & { cancel(): boolean };
    invoke(operation: 'git.info', request: { readonly directory: string }): Promise<NativeGitStatusResult> & { cancel(): boolean };
    invoke(operation: 'encoding.describe', request: { readonly codepage: number }): Promise<NativeCodepage>;
    invoke(operation: 'encoding.decodeBlock', request: NativeDecodeRequest): Promise<NativeDecodedBlock>;
    invoke(operation: 'encoding.decodeChunk', request: NativeDecodeChunkRequest): Promise<NativeDecodedChunk>;
    close(): boolean;
    whenClosed(): Promise<void>;
  };
}

export function createNativeApi(binding: NativeBinding): NativeApi;
export function loadNativeApi(): NativeApi;
