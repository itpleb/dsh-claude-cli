/**
 * Process lifecycle for one `claude` invocation.
 *
 * Owns the parts a subprocess boundary makes non-obvious: newline framing
 * across chunk boundaries, an idle watchdog that arms only while the consumer
 * is actually waiting, abort propagation, and a terminate-then-kill teardown
 * that runs on every exit path including the early return the adapter takes
 * when a turn ends in a tool call.
 *
 * @module dsh-claude-cli/cli
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { ABORTED_CODE, CLI_NOT_FOUND_CODE, TIMEOUT_CODE } from './failure.ts'

/** Grace period between `SIGTERM` and `SIGKILL`, in milliseconds. */
const KILL_GRACE_MS = 2000

/** Candidate paths for the `claude` executable by platform. */
function claudeCandidatePaths(): string[] {
  const home = homedir()
  const isWin = process.platform === 'win32'
  const exe = isWin ? 'claude.exe' : 'claude'

  const candidates: string[] = []

  // 1. User-local installs (most common)
  if (!isWin) {
    candidates.push(join(home, '.local', 'bin', exe))
    candidates.push(join(home, 'bin', exe))
  } else {
    candidates.push(join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', exe))
    candidates.push(join(home, 'scoop', 'shims', exe))
    candidates.push(join(home, '.local', 'bin', exe))
  }

  // 2. npm/pnpm/yarn global prefixes
  const npmPrefix = process.env.npm_config_prefix
  if (npmPrefix) candidates.push(join(npmPrefix, 'bin', exe))
  const pnpmHome = process.env.PNPM_HOME
  if (pnpmHome) candidates.push(join(pnpmHome, exe))
  const yarnGlobal = process.env.YARN_GLOBAL_FOLDER
  if (yarnGlobal) candidates.push(join(yarnGlobal, 'node_modules', '.bin', exe))

  // 3. Node version managers
  const nvmDir = process.env.NVM_DIR
  if (nvmDir) {
    const nodeVersion = process.version
    candidates.push(join(nvmDir, 'versions', 'node', nodeVersion, 'bin', exe))
  }
  const fnmDir = process.env.FNM_DIR
  if (fnmDir) {
    candidates.push(join(fnmDir, 'node-versions', process.version, 'installation', 'bin', exe))
  }
  const voltaHome = process.env.VOLTA_HOME
  if (voltaHome) candidates.push(join(voltaHome, 'bin', exe))

  // 4. System-wide (less common for claude)
  if (!isWin) {
    candidates.push(join('/usr', 'local', 'bin', exe))
    candidates.push(join('/opt', 'homebrew', 'bin', exe)) // Apple Silicon Homebrew
  }

  return candidates
}

/**
 * Resolve the `claude` executable path.
 * Checks PATH first, then common install locations.
 * @param explicit - user-configured path/command; if absolute or contains a path separator, used as-is.
 * @returns absolute path to the executable.
 * @throws LlmError `CLI_NOT_FOUND` with a diagnostic list of searched locations.
 */
export async function resolveClaudeExecutable(explicit: string): Promise<string> {
  // If the user gave a path with a separator, treat it as a filesystem path.
  if (explicit.includes('/') || explicit.includes('\\')) {
    try {
      await access(explicit, constants.X_OK)
      return explicit
    } catch {
      throw new LlmError(
        `The configured \`claude\` executable at "${explicit}" does not exist or is not executable.`,
        CLI_NOT_FOUND_CODE,
      )
    }
  }

  // 1. Try PATH lookup via `command -v` / `where` equivalent.
  // Node's spawn will do PATH resolution when given a bare command.
  // We verify it exists by trying to spawn with `command -v` (unix) or `where` (windows).
  const isWin = process.platform === 'win32'
  try {
    const checkCmd = isWin ? 'where' : 'command'
    const checkArgs = isWin ? [explicit] : ['-v', explicit]
    const { spawnSync } = await import('node:child_process')
    const result = spawnSync(checkCmd, checkArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const stdout = result.stdout?.trim()
    if (result.status === 0 && stdout && stdout.length > 0) {
      return stdout.split('\n')[0]!
    }
  } catch {
    // Fall through to candidate paths
  }

  // 2. Check known candidate paths.
  for (const candidate of claudeCandidatePaths()) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // continue
    }
  }

  // 3. Give up with a helpful diagnostic.
  const searched = [
    'PATH (via `command -v` / `where`)',
    ...claudeCandidatePaths(),
  ]
  throw new LlmError(
    `The \`claude\` executable was not found.\n`
    + 'Searched:\n  - ' + searched.join('\n  - ') + '\n'
    + 'Install Claude Code (https://claude.com/claude-code) and ensure it is on PATH, '
    + 'or set the `executable` config to the absolute path.',
    CLI_NOT_FOUND_CODE,
  )
}

/** Everything needed to launch one CLI process. */
export interface CliInvocation {
  /** Resolved absolute path to the `claude` executable. */
  executable: string
  args: readonly string[]
  /** The stream-json user turn written to stdin, which is then closed. */
  stdinPayload: string
  cwd: string
  env: NodeJS.ProcessEnv
}

/** Controls for one running CLI process. */
export interface CliRun {
  /** Stdout lines in order, ending when the process closes its stdout. */
  lines: AsyncIterableIterator<string>
  /** Terminate the process and release its listeners; repeat calls are no-ops. */
  close: () => void
  /** Everything the process has written to stderr, for diagnostics. */
  stderr: () => string
  /** Exit code, or null while the process is still running. */
  exitCode: () => number | null
}

/**
 * Launch one CLI process and expose its stdout as lines.
 *
 * @param invocation - executable, arguments, stdin payload, and environment.
 * @param options - caller abort and the idle bound between stdout lines.
 * @returns handles for reading the process and tearing it down.
 * @throws LlmError `CLI_NOT_FOUND` when the executable cannot be spawned.
 */
export function runCli(
  invocation: CliInvocation,
  options: { signal?: AbortSignal; idleTimeoutMs: number },
): CliRun {
  const child: ChildProcessWithoutNullStreams = spawn(
    invocation.executable,
    [...invocation.args],
    { cwd: invocation.cwd, env: invocation.env, stdio: ['pipe', 'pipe', 'pipe'] },
  )

  const queue: string[] = []
  let pending: (() => void) | undefined
  let stdoutRest = ''
  let stderrText = ''
  let finished = false
  let failure: Error | undefined
  let exit: number | null = null
  let killTimer: NodeJS.Timeout | undefined
  let idleTimer: NodeJS.Timeout | undefined

  const wake = (): void => {
    const resume = pending
    pending = undefined
    resume?.()
  }

  const settle = (error?: Error): void => {
    if (finished) return
    finished = true
    failure ??= error
    wake()
  }

  const close = (): void => {
    if (killTimer !== undefined) return
    settle()
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
      killTimer.unref()
    } else {
      // Already exited; mark teardown as done so a repeat call is a no-op.
      killTimer = setTimeout(() => {}, 0)
      killTimer.unref()
    }
    child.stdout.destroy()
    child.stderr.destroy()
    options.signal?.removeEventListener('abort', onAbort)
  }

  function onAbort(): void {
    settle(new LlmError('The request was aborted by the caller.', ABORTED_CODE))
    close()
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    const text = stdoutRest + chunk
    const parts = text.split('\n')
    stdoutRest = parts.pop() ?? ''
    for (const part of parts) {
      if (part.length > 0) queue.push(part)
    }
    wake()
  })
  child.stdout.on('end', () => {
    if (stdoutRest.length > 0) {
      queue.push(stdoutRest)
      stdoutRest = ''
    }
    settle()
  })

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderrText += chunk
  })

  child.on('error', (error: NodeJS.ErrnoException) => {
    settle(
      error.code === 'ENOENT'
        ? new LlmError(
          `The \`${invocation.executable}\` executable was not found.`
          + ' Install Claude Code and make it available on PATH, or set `executable`.',
          CLI_NOT_FOUND_CODE,
          { cause: error },
        )
        : error,
    )
  })
  child.on('exit', (code) => {
    exit = code
  })

  if (options.signal?.aborted === true) onAbort()
  else options.signal?.addEventListener('abort', onAbort, { once: true })

  // A process that exits before reading its input makes the write fail; the
  // exit itself is the meaningful event and is already observed above.
  child.stdin.on('error', () => {})
  child.stdin.end(invocation.stdinPayload)

  const lines: AsyncIterableIterator<string> = {
    [Symbol.asyncIterator]() {
      return this
    },
    async next(): Promise<IteratorResult<string>> {
      for (;;) {
        const line = queue.shift()
        if (line !== undefined) return { value: line, done: false }
        if (finished) {
          if (failure !== undefined) {
            const error = failure
            failure = undefined
            throw error
          }
          return { value: undefined, done: true }
        }
        await new Promise<void>((resolve) => {
          pending = resolve
          idleTimer = setTimeout(() => {
            settle(new LlmError(
              `The \`claude\` process produced no output for ${options.idleTimeoutMs}ms.`,
              TIMEOUT_CODE,
            ))
          }, options.idleTimeoutMs)
          idleTimer.unref()
        })
        clearTimeout(idleTimer)
      }
    },
    async return(): Promise<IteratorResult<string>> {
      close()
      return { value: undefined, done: true }
    },
  }

  return { lines, close, stderr: () => stderrText, exitCode: () => exit }
}
