import {
  CommandExitError,
  Sandbox,
  SandboxError,
  SandboxNotFoundError,
  TimeoutError,
  type CommandResult,
} from '@e2b/code-interpreter'

export type SupportedLanguage = 'python' | 'javascript'
export type ExecutionErrorType =
  | 'validation_error'
  | 'execution_error'
  | 'timeout'
  | 'out_of_memory'
  | 'sandbox_not_found'
  | 'sandbox_error'

export type StreamHandler = (line: string) => void

export interface ExecuteRequest {
  code: string
  language: SupportedLanguage
  onStdout?: StreamHandler
  onStderr?: StreamHandler
  timeoutMs?: number
}

export interface ExecuteResult {
  conversationId: string
  sandboxId: string | null
  language: SupportedLanguage
  ok: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  errorType?: ExecutionErrorType
  error?: string
}

export type SessionManagerOptions = {
  sandboxTimeoutMs?: number
  commandTimeoutMs?: number
  workDir?: string
}

type SessionRecord = {
  conversationId: string
  sandboxId: string
  sandbox: Sandbox
  turnCount: number
  cleanupTimer?: NodeJS.Timeout
}

export type SessionSummary = Pick<SessionRecord, 'conversationId' | 'sandboxId' | 'turnCount'>

type StreamBuffer = {
  stdout: string
  stderr: string
}

type NormalizedError = {
  message: string
  exitCode: number | null
  stdout: string
  stderr: string
  errorType: ExecutionErrorType
}

const DEFAULT_SANDBOX_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 1000
const DEFAULT_WORK_DIR = 'e2b-session-manager'

export class SandboxSessionManager {
  // In production, persist sandboxId with the conversation so another backend
  // worker can reconnect after a process restart or request handoff.
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly sandboxTimeoutMs: number
  private readonly commandTimeoutMs: number
  private readonly workDir: string

  constructor(options: SessionManagerOptions = {}) {
    this.sandboxTimeoutMs = options.sandboxTimeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
    this.workDir = options.workDir ?? DEFAULT_WORK_DIR
  }

  // Public API

  async execute(conversationId: string, request: ExecuteRequest): Promise<ExecuteResult> {
    const validationError = validateRequest(request)
    if (validationError) {
      return failedResult(conversationId, null, request.language, {
        message: validationError,
        errorType: 'validation_error',
      })
    }

    const stream: StreamBuffer = { stdout: '', stderr: '' }
    let session: SessionRecord | undefined

    try {
      session = await this.getOrCreateSession(conversationId)

      const filePath = await this.writeTurnFile(session, request)
      const result = await this.runTurn(session, request, filePath, stream)

      this.scheduleIdleCleanup(session)
      return resultFromCommand(conversationId, session.sandboxId, request.language, result, stream)
    } catch (error) {
      if (session) this.scheduleIdleCleanup(session)
      return resultFromError(conversationId, session?.sandboxId ?? null, request.language, error, stream)
    }
  }

  // Cleanup and visibility

  async disposeConversation(conversationId: string): Promise<void> {
    const session = this.sessions.get(conversationId)
    if (!session) return

    if (session.cleanupTimer) clearTimeout(session.cleanupTimer)
    this.sessions.delete(conversationId)

    try {
      await session.sandbox.kill()
    } catch (error) {
      console.warn(`Failed to kill sandbox ${session.sandboxId}: ${errorMessage(error)}`)
    }
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((conversationId) => this.disposeConversation(conversationId)))
  }

  listSessions(): SessionSummary[] {
    return [...this.sessions.values()].map(({ conversationId, sandboxId, turnCount }) => ({
      conversationId,
      sandboxId,
      turnCount,
    }))
  }

  // Session lifecycle

  private async getOrCreateSession(conversationId: string): Promise<SessionRecord> {
    const existing = this.sessions.get(conversationId)
    if (existing) return (await this.reuseOrReplaceSession(existing)) ?? (await this.createSession(conversationId))
    return this.createSession(conversationId)
  }

  private async reuseOrReplaceSession(session: SessionRecord): Promise<SessionRecord | null> {
    try {
      await session.sandbox.setTimeout(this.sandboxTimeoutMs)
      return session
    } catch {
      try {
        session.sandbox = await Sandbox.connect(session.sandboxId)
        await session.sandbox.setTimeout(this.sandboxTimeoutMs)
        return session
      } catch {
        this.forgetSession(session.conversationId)
        return null
      }
    }
  }

  private async createSession(conversationId: string): Promise<SessionRecord> {
    const sandbox = await Sandbox.create({ timeoutMs: this.sandboxTimeoutMs })
    const session: SessionRecord = {
      conversationId,
      sandboxId: sandbox.sandboxId,
      sandbox,
      turnCount: 0,
    }

    this.sessions.set(conversationId, session)
    this.scheduleIdleCleanup(session)
    return session
  }

  // Code execution

  private async writeTurnFile(session: SessionRecord, request: ExecuteRequest): Promise<string> {
    const turn = session.turnCount + 1
    const filePath = this.filePath(session.conversationId, turn, request.language)

    session.turnCount = turn
    await session.sandbox.commands.run(`mkdir -p ${shellQuote(this.conversationDir(session.conversationId))}`, {
      timeoutMs: 5_000,
    })
    await session.sandbox.files.write(filePath, request.code)

    return `turn-${turn}.${this.fileExtension(request.language)}`
  }

  private async runTurn(
    session: SessionRecord,
    request: ExecuteRequest,
    filePath: string,
    stream: StreamBuffer
  ): Promise<CommandResult> {
    const command = `cd ${shellQuote(this.conversationDir(session.conversationId))} && ${this.commandFor(
      request.language,
      filePath
    )}`

    return session.sandbox.commands.run(command, {
      timeoutMs: request.timeoutMs ?? this.commandTimeoutMs,
      onStdout: (data) => {
        stream.stdout += data
        request.onStdout?.(data)
      },
      onStderr: (data) => {
        stream.stderr += data
        request.onStderr?.(data)
      },
    })
  }

  private forgetSession(conversationId: string): void {
    const session = this.sessions.get(conversationId)
    if (session?.cleanupTimer) clearTimeout(session.cleanupTimer)
    this.sessions.delete(conversationId)
  }

  // Local cleanup

  private scheduleIdleCleanup(session: SessionRecord): void {
    if (session.cleanupTimer) clearTimeout(session.cleanupTimer)

    // E2B enforces the remote timeout; this keeps the local map clean too.
    session.cleanupTimer = setTimeout(() => {
      void this.disposeConversation(session.conversationId)
    }, this.sandboxTimeoutMs)

    session.cleanupTimer.unref?.()
  }

  // Paths and commands

  private conversationDir(conversationId: string): string {
    return `${this.workDir}/${safeName(conversationId)}`
  }

  private filePath(conversationId: string, turn: number, language: SupportedLanguage): string {
    return `${this.conversationDir(conversationId)}/turn-${turn}.${this.fileExtension(language)}`
  }

  private commandFor(language: SupportedLanguage, filePath: string): string {
    if (language === 'python') return `python3 ${shellQuote(filePath)}`
    return `node ${shellQuote(filePath)}`
  }

  private fileExtension(language: SupportedLanguage): string {
    return language === 'python' ? 'py' : 'js'
  }
}

// Result handling

function validateRequest(request: ExecuteRequest): string | null {
  if (!request.code.trim()) return 'No generated code was provided.'
  if (request.language !== 'python' && request.language !== 'javascript') {
    return `Unsupported language: ${String(request.language)}`
  }
  return null
}

function resultFromCommand(
  conversationId: string,
  sandboxId: string,
  language: SupportedLanguage,
  result: CommandResult,
  stream: StreamBuffer
): ExecuteResult {
  const stdout = result.stdout ?? stream.stdout
  const stderr = result.stderr ?? stream.stderr
  const ok = result.exitCode === 0

  return {
    conversationId,
    sandboxId,
    language,
    ok,
    exitCode: result.exitCode,
    stdout,
    stderr,
    ...(ok
      ? {}
      : {
          errorType: classifyCommandFailure(result.exitCode, stderr, result.error),
          error: result.error ?? stderr,
        }),
  }
}

function resultFromError(
  conversationId: string,
  sandboxId: string | null,
  language: SupportedLanguage,
  error: unknown,
  stream: StreamBuffer
): ExecuteResult {
  const normalized = normalizeExecutionError(error)

  return {
    conversationId,
    sandboxId,
    language,
    ok: false,
    exitCode: normalized.exitCode,
    stdout: normalized.stdout || stream.stdout,
    stderr: normalized.stderr || stream.stderr,
    errorType: normalized.errorType,
    error: normalized.message,
  }
}

function failedResult(
  conversationId: string,
  sandboxId: string | null,
  language: SupportedLanguage,
  failure: { message: string; errorType: ExecutionErrorType }
): ExecuteResult {
  return {
    conversationId,
    sandboxId,
    language,
    ok: false,
    exitCode: null,
    stdout: '',
    stderr: '',
    errorType: failure.errorType,
    error: failure.message,
  }
}

// Error classification

function normalizeExecutionError(error: unknown): NormalizedError {
  if (error instanceof CommandExitError) {
    return {
      message: error.error ?? error.message,
      exitCode: error.exitCode,
      stdout: error.stdout,
      stderr: error.stderr,
      errorType: classifyCommandFailure(error.exitCode, error.stderr, error.error ?? error.message),
    }
  }

  if (error instanceof TimeoutError) {
    return {
      message: error.message,
      exitCode: null,
      stdout: '',
      stderr: '',
      errorType: 'timeout',
    }
  }

  if (error instanceof SandboxNotFoundError) {
    return {
      message: error.message,
      exitCode: null,
      stdout: '',
      stderr: '',
      errorType: 'sandbox_not_found',
    }
  }

  if (error instanceof SandboxError) {
    return {
      message: error.message,
      exitCode: null,
      stdout: '',
      stderr: '',
      errorType: 'sandbox_error',
    }
  }

  return {
    message: errorMessage(error),
    exitCode: null,
    stdout: '',
    stderr: '',
    errorType: 'sandbox_error',
  }
}

function classifyCommandFailure(exitCode: number | null, stderr: string, message = ''): ExecutionErrorType {
  if (exitCode === 137 || exitCode === 134) return 'out_of_memory'

  const text = `${message}\n${stderr}`.toLowerCase()
  if (text.includes('memoryerror') || text.includes('out of memory') || text.includes('heap limit')) {
    return 'out_of_memory'
  }

  return 'execution_error'
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_')
}
