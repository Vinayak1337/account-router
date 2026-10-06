import type { Register } from 'claude-code'

// Claude delegates work to pi subagents that run on the Codex account pool
// (the codex-accounts pi extension), which switches ChatGPT accounts itself.
const TOOL = 'codex_subagent'
const DEFAULT_MODEL = 'gpt-6-luna'
const READ_ONLY_TOOLS = 'read,grep,find,ls'
const MAX_OUTPUT = 60_000

let running = 0

const uuid = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })

type PoolState = { accounts?: Record<string, { lastUsedAt?: number | null; email?: string | null }> }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: TOOL,
      description: [
        'Spawn a Codex subagent: pi running on your ChatGPT accounts through the codex-pool provider, which switches accounts automatically when one hits its limit.',
        'Use it to delegate self-contained work (research, review, focused edits). Call it several times in one message to run subagents in parallel.',
        'The subagent cannot see this conversation: put every needed detail, path and constraint in `task`, and say what to report back.',
        'access "read-only" (default) allows read/grep/find/ls; "edit" also allows bash, edit and write in `cwd`, without sandbox, so use it only for work you intend to apply.',
        'Returns the subagent\'s final answer and a session_id; pass session_id with a new task to continue that subagent.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Complete, self-contained instructions, including what to report back.' },
          cwd: { type: 'string', description: 'Folder the subagent works in (default: this session\'s folder).' },
          access: { type: 'string', enum: ['read-only', 'edit'], description: 'Default read-only.' },
          model: {
            type: 'string',
            description: `Codex model (default ${DEFAULT_MODEL}); e.g. gpt-6.1-sol, gpt-6-astra, gpt-5.6-terra. Accounts whose plan lacks it are skipped.`,
          },
          thinking: { type: 'string', enum: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'], description: 'Reasoning effort (default medium).' },
          session_id: { type: 'string', description: 'Continue an earlier subagent instead of starting fresh.' },
          timeout_minutes: { type: 'number', description: 'Stop the subagent after this long (default 30, max 120).' },
        },
        required: ['task'],
      },
    })
    return started
  })

  on('tool.call', { tool: 'mcp__pi-subagents__codex_subagent' }, async ($, e) => {
    const input = e as unknown as {
      task?: string
      cwd?: string
      access?: string
      model?: string
      thinking?: string
      session_id?: string
      timeout_minutes?: number
    }
    if (!input.task?.trim()) return { deny: 'Give the subagent a task.' }
    const home = (await $.env.get('HOME')) ?? ''
    const override = await $.env.get('PI_SUBAGENT_BIN')
    let pi: string | undefined
    for (const candidate of [override, `${home}/.bun/bin/pi`, '/opt/homebrew/bin/pi', '/usr/local/bin/pi']) {
      if (!candidate) continue
      try {
        await $.fs.stat(candidate)
        pi = candidate
        break
      } catch {}
    }
    if (!pi) return { deny: 'pi was not found. Install it (bun i -g @earendil-works/pi-coding-agent) or set PI_SUBAGENT_BIN.' }

    const session = input.session_id?.trim() || uuid()
    const model = input.model?.trim() || DEFAULT_MODEL
    const thinking = input.thinking || 'medium'
    const edit = input.access === 'edit'
    const argv = [
      pi,
      '-p',
      '--provider', 'codex-pool',
      '--model', model,
      '--thinking', thinking,
      '--session-dir', `${home}/.pi/agent/claude-subagents`,
      '--session-id', session,
      ...(edit ? [] : ['--tools', READ_ONLY_TOOLS]),
    ]
    const statePath = `${home}/.pi/agent/codex-accounts.json`
    const readState = async (): Promise<PoolState> => {
      try {
        return JSON.parse(await $.fs.read(statePath))
      } catch {
        return {}
      }
    }
    const before = await readState()
    const limitMs = Math.min(120, Math.max(1, input.timeout_minutes ?? 30)) * 60_000
    const started = Date.now()

    running++
    $.ui.status(`pi subagents: ${running} running`)
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let code: number | null = null
    try {
      // The task goes over stdin, so text starting with "@" or "-" is never read as a flag or file.
      const child = $.process.spawn({ argv, cwd: input.cwd, input: input.task })
      for await (const piece of child) {
        if (piece.stream === 'stdout') stdout += piece.text
        else stderr += piece.text
        if (Date.now() - started > limitMs) {
          timedOut = true
          break // leaving the loop stops the child
        }
      }
      if (!timedOut) code = (await child.result).code
    } catch (error) {
      stderr += `\n${error instanceof Error ? error.message : String(error)}`
    } finally {
      running--
      $.ui.status(running ? `pi subagents: ${running} running` : undefined)
    }

    // Which pool account served it, from the pool's own record.
    const after = await readState()
    const served = Object.entries(after.accounts ?? {})
      .filter(([id, a]) => (a.lastUsedAt ?? 0) > (before.accounts?.[id]?.lastUsedAt ?? 0))
      .map(([id, a]) => (a.email ? `${id} (${a.email})` : id))
    const minutes = ((Date.now() - started) / 60_000).toFixed(1)
    const footer = `\n\n[pi subagent · ${model} · ${edit ? 'edit' : 'read-only'} · ${served.length ? `account ${served.join(', ')}` : 'account unknown'} · ${minutes} min · session_id ${session}]`
    const answer = stdout.trim()
    if (timedOut)
      return { result: `${answer || '(no answer yet)'}\n\nStopped after ${minutes} minutes (timeout).${footer}` }
    if (code !== 0 || !answer)
      return {
        result: `The subagent failed${code === null ? '' : ` (exit ${code})`}:\n${(stderr.trim() || answer || 'no output').slice(-4000)}${footer}`,
      }
    return {
      result:
        (answer.length > MAX_OUTPUT ? `${answer.slice(0, MAX_OUTPUT)}\n…(${answer.length - MAX_OUTPUT} more characters cut)` : answer) +
        footer,
    }
  })
}
