import type {
  AgentSideConnection,
  ClientCapabilities,
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationPropertySchema,
  PermissionOption,
  SessionUpdate
} from '@agentclientprotocol/sdk'
import type { PiRpcEvent, PiRpcProcess } from '../pi-rpc/process.js'
import { ENV_EXTENSION_UI_DEBUG, parseBooleanSetting, type ExtensionUiMode } from './acp-settings.js'

/**
 * Bridges pi's extension UI protocol (`extension_ui_request` / `extension_ui_response`,
 * see pi's `docs/rpc.md`) onto ACP.
 *
 * pi extensions call `ctx.ui.select()`, `ctx.ui.confirm()`, `ctx.ui.input()`, etc. In RPC
 * mode pi turns those into `extension_ui_request` events. This module decides how each one
 * reaches the user and always answers pi exactly once where pi expects an answer.
 *
 * Two categories exist, and mixing them up hangs or spams the extension:
 *
 * - **Dialog methods** (`select`, `confirm`, `input`, `editor`): block until answered.
 *   Exactly one `extension_ui_response` must be sent.
 * - **Fire-and-forget methods** (`notify`, `setStatus`, `setWidget`, `setTitle`,
 *   `set_editor_text`): pi expects *no* response.
 *
 * To add support for a new method, add it to {@link DIALOG_HANDLERS} or
 * {@link FIRE_AND_FORGET_HANDLERS}; everything else (dispatch, response shape, timeouts,
 * graceful degradation) is handled here.
 */

export const CHOICE_OPTION_PREFIX = 'choice-'

export const CONFIRM_PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
  { optionId: 'no', name: 'No', kind: 'reject_once' }
]

/** Request fields forwarded into the ACP permission tool call for context/debugging. */
const EXTENSION_UI_RAW_INPUT_KEYS = ['title', 'message', 'options', 'placeholder', 'prefill'] as const

/** Property name used for the single input of an elicitation form. */
const ELICITATION_FIELD = 'value'

export type ExtensionUiBridgeDeps = {
  conn: AgentSideConnection
  sessionId: string
  proc: PiRpcProcess
  /** Dialog strategy. See {@link ExtensionUiMode}. */
  mode: ExtensionUiMode
  /** True when the ACP client advertised `clientCapabilities.elicitation.form`. */
  supportsElicitationForm: boolean
  /** Emit a session update (normally `agent_message_chunk`). */
  emit: (update: SessionUpdate) => void
  /**
   * Surface fire-and-forget requests (`setStatus`, `setWidget`, ...) as diagnostics.
   * Defaults to `PI_ACP_EXTENSION_UI_DEBUG`.
   */
  debug?: boolean
}

export type ExtensionUiBridge = {
  /**
   * Handle one `extension_ui_request`. Returns `true` when the method was recognized
   * (including graceful degradation).
   */
  handle(ev: PiRpcEvent): Promise<boolean>
}

type DialogOutcome =
  | { kind: 'value'; value: string | undefined }
  | { kind: 'confirmed'; confirmed: boolean }
  | { kind: 'cancelled' }
  /** pi's own `timeout` already resolved the dialog, so pi must NOT receive a response. */
  | { kind: 'no-response' }

type DialogContext = {
  deps: ExtensionUiBridgeDeps
  ev: PiRpcEvent
  id: string
  /** Dialog methods may carry a `timeout`; pi auto-resolves its own side when it expires. */
  timeoutMs: number | undefined
}

type DialogHandler = (ctx: DialogContext) => Promise<DialogOutcome>

type FireAndForgetContext = {
  deps: ExtensionUiBridgeDeps
  ev: PiRpcEvent
  debug: boolean
}

type FireAndForgetHandler = (ctx: FireAndForgetContext) => void

// ---------------------------------------------------------------------------
// Dispatch tables (the extension point)
// ---------------------------------------------------------------------------

const DIALOG_HANDLERS: Record<string, DialogHandler> = {
  select: handleSelect,
  confirm: handleConfirm,
  input: handleInput,
  editor: handleEditor
}

const FIRE_AND_FORGET_HANDLERS: Record<string, FireAndForgetHandler> = {
  notify: handleNotify,
  setStatus: debugOnly('setStatus'),
  setWidget: debugOnly('setWidget'),
  setTitle: debugOnly('setTitle'),
  set_editor_text: debugOnly('set_editor_text')
}

/** Methods that pi-acp can never render, with a method-specific explanation. */
const KNOWN_UNSUPPORTED_DIALOGS: Record<string, string> = {
  custom:
    'pi renders `custom()` UI with direct terminal access, which is unavailable over ACP (`custom()` already returns undefined in RPC mode).'
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

/**
 * Create a bridge for one session. The returned `handle` never throws: every failure path
 * either cancels the dialog or explains the degradation so the extension's promise settles.
 */
export function createExtensionUiBridge(deps: ExtensionUiBridgeDeps): ExtensionUiBridge {
  const debug = deps.debug ?? parseBooleanSetting(process.env[ENV_EXTENSION_UI_DEBUG]) === true

  const respond = async (id: string, outcome: DialogOutcome): Promise<void> => {
    if (outcome.kind === 'no-response') return

    if (outcome.kind === 'cancelled') {
      await deps.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }
    if (outcome.kind === 'confirmed') {
      await deps.proc.sendExtensionUiResponse({ id, confirmed: outcome.confirmed })
      return
    }
    await deps.proc.sendExtensionUiResponse(
      outcome.value === undefined ? { id, cancelled: true } : { id, value: outcome.value }
    )
  }

  const explain = (text: string): void => {
    deps.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text }
    })
  }

  return {
    async handle(ev: PiRpcEvent): Promise<boolean> {
      const method = stringProp(ev, 'method')
      if (!method) return false

      const fireAndForget = FIRE_AND_FORGET_HANDLERS[method]
      if (fireAndForget) {
        fireAndForget({ deps, ev, debug })
        // Fire-and-forget methods never get a response; pi does not expect one.
        return true
      }

      const id = stringProp(ev, 'id')
      if (!id) return false

      const dialog = DIALOG_HANDLERS[method]
      if (!dialog) {
        const detail = KNOWN_UNSUPPORTED_DIALOGS[method]
        explain(
          detail
            ? `Pi requested an unsupported "${method}" dialog. ${detail} The request was declined; the session is still usable.`
            : `Pi requested an unrecognized dialog method "${method}", which this adapter does not implement. The request was declined; the session is still usable.`
        )
        await respond(id, { kind: 'cancelled' })
        return true
      }

      let outcome: DialogOutcome
      try {
        outcome = await dialog({ deps, ev, id, timeoutMs: numberProp(ev, 'timeout') })
      } catch (error) {
        explain(`Extension "${method}" dialog failed: ${errorText(error)}. The request was declined.`)
        outcome = { kind: 'cancelled' }
      }

      await respond(id, outcome)
      return true
    }
  }
}

// ---------------------------------------------------------------------------
// Dialog handlers
// ---------------------------------------------------------------------------

async function handleSelect(ctx: DialogContext): Promise<DialogOutcome> {
  const { deps, ev, timeoutMs } = ctx

  const options = Array.isArray(ev.options) ? ev.options.map(option => String(option)) : []
  if (!options.length) return { kind: 'cancelled' }

  const title = dialogTitle(ev, 'select')

  if (deps.mode === 'off') {
    return declinedBySettings(deps, 'select', title)
  }

  if (deps.mode === 'auto' && deps.supportsElicitationForm) {
    const result = await elicit(deps, {
      message: title,
      timeoutMs,
      property: {
        type: 'string',
        title,
        enum: options
      }
    })

    const outcome = elicitationOutcome(result, value => {
      if (typeof value !== 'string' || !options.includes(value)) return { kind: 'cancelled' }
      return { kind: 'value', value }
    })
    if (outcome) return outcome
  }

  const picked = await permissionChoice(deps, ev, options, timeoutMs)
  if (picked.status === 'no-response') return { kind: 'no-response' }
  return picked.status === 'value' ? { kind: 'value', value: picked.value } : { kind: 'cancelled' }
}

async function handleConfirm(ctx: DialogContext): Promise<DialogOutcome> {
  const { deps, ev, timeoutMs } = ctx
  const title = dialogTitle(ev, 'confirm')
  const message = stringProp(ev, 'message')

  if (deps.mode === 'off') {
    return declinedBySettings(deps, 'confirm', title)
  }

  if (deps.mode === 'auto' && deps.supportsElicitationForm) {
    const result = await elicit(deps, {
      message: message ? `${title}\n\n${message}` : title,
      timeoutMs,
      property: {
        type: 'boolean',
        title,
        description: message ?? undefined,
        default: true
      }
    })

    const outcome = elicitationOutcome(result, value => ({ kind: 'confirmed', confirmed: value === true }))
    if (outcome) return outcome
  }

  const settled = await raceTimeout(requestExtensionPermission(deps, ev, CONFIRM_PERMISSION_OPTIONS), timeoutMs)
  if (settled.timedOut) return { kind: 'no-response' }

  const selected = settled.value
  if (selected === null || selected.outcome.outcome === 'cancelled') return { kind: 'cancelled' }
  return { kind: 'confirmed', confirmed: selected.outcome.optionId === 'yes' }
}

async function handleInput(ctx: DialogContext): Promise<DialogOutcome> {
  const { deps, ev, timeoutMs } = ctx
  const title = dialogTitle(ev, 'input')
  const placeholder = stringProp(ev, 'placeholder')

  if (deps.mode === 'off') {
    return declinedBySettings(deps, 'input', title)
  }

  if (deps.mode === 'auto' && deps.supportsElicitationForm) {
    const result = await elicit(deps, {
      message: title,
      timeoutMs,
      property: {
        type: 'string',
        title,
        description: placeholder ?? undefined
      }
    })

    const outcome = elicitationOutcome(result, value => ({
      kind: 'value',
      value: typeof value === 'string' ? value : undefined
    }))
    if (outcome) return outcome
  }

  return textDialogUnsupported(deps, 'input', title)
}

async function handleEditor(ctx: DialogContext): Promise<DialogOutcome> {
  const { deps, ev, timeoutMs } = ctx
  const title = dialogTitle(ev, 'editor')
  const prefill = stringProp(ev, 'prefill')

  if (deps.mode === 'off') {
    return declinedBySettings(deps, 'editor', title)
  }

  if (deps.mode === 'auto' && deps.supportsElicitationForm) {
    const result = await elicit(deps, {
      message: title,
      timeoutMs,
      property: {
        type: 'string',
        title,
        description: 'Multi-line text',
        default: prefill ?? undefined
      }
    })

    const outcome = elicitationOutcome(result, value => ({
      kind: 'value',
      value: typeof value === 'string' ? value : undefined
    }))
    if (outcome) return outcome
  }

  return textDialogUnsupported(deps, 'editor', title)
}

// ---------------------------------------------------------------------------
// Fire-and-forget handlers
// ---------------------------------------------------------------------------

function handleNotify({ deps, ev }: FireAndForgetContext): void {
  // Notifications are user-visible regardless of debug mode.
  deps.emit({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: stringProp(ev, 'message') ?? 'Pi notification' },
    _meta: { piAcp: { notify: { level: stringProp(ev, 'notifyType') ?? 'info' } } }
  })
}

/**
 * Fire-and-forget methods ACP has no surface for. They are dropped silently unless
 * `PI_ACP_EXTENSION_UI_DEBUG=1`, so extension status/widget churn cannot pollute the
 * conversation.
 */
function debugOnly(method: string): FireAndForgetHandler {
  return ({ deps, ev, debug }) => {
    if (!debug) return
    const summary = summarizeFireAndForget(method, ev)
    if (!summary) return
    deps.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `[pi-acp debug] ${method}: ${summary}` }
    })
  }
}

function summarizeFireAndForget(method: string, ev: PiRpcEvent): string | null {
  switch (method) {
    case 'setStatus': {
      const key = stringProp(ev, 'statusKey') ?? '?'
      const text = stringProp(ev, 'statusText')
      return text ? `${key} = ${text}` : `cleared ${key}`
    }
    case 'setWidget': {
      const key = stringProp(ev, 'widgetKey') ?? '?'
      const lines = Array.isArray(ev.widgetLines) ? ev.widgetLines.length : 0
      return lines ? `${key}: ${lines} line(s)` : `cleared ${key}`
    }
    case 'setTitle':
      return stringProp(ev, 'title') ?? 'cleared'
    case 'set_editor_text':
      return `${(stringProp(ev, 'text') ?? '').length} char(s)`
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// ACP mechanism helpers
// ---------------------------------------------------------------------------

type ElicitOutcome =
  | { status: 'accept'; value: unknown }
  | { status: 'decline' }
  | { status: 'cancel' }
  | { status: 'unsupported' }
  | { status: 'timeout' }

/**
 * Ask the client to render a one-field form.
 *
 * `unsupported` means the client could not handle the request at all, so callers may fall
 * back to another mechanism. Every other status is a real user outcome.
 */
async function elicit(
  deps: ExtensionUiBridgeDeps,
  params: { message: string; property: ElicitationPropertySchema; timeoutMs: number | undefined }
): Promise<ElicitOutcome> {
  const request = {
    mode: 'form',
    sessionId: deps.sessionId,
    message: params.message,
    requestedSchema: {
      type: 'object',
      properties: { [ELICITATION_FIELD]: params.property },
      required: [ELICITATION_FIELD]
    }
  } as unknown as CreateElicitationRequest

  const create = deps.conn.unstable_createElicitation?.bind(deps.conn)
  if (!create) return { status: 'unsupported' }

  const settled = await raceTimeout(
    create(request).then(
      (response: CreateElicitationResponse) => ({ ok: true as const, response }),
      (error: unknown) => ({ ok: false as const, error })
    ),
    params.timeoutMs
  )

  if (settled.timedOut) {
    // pi auto-resolves its own side when `timeout` expires, so we must NOT answer here.
    return { status: 'timeout' }
  }

  if (!settled.value.ok) {
    // Old clients answer unknown methods with "Method not found"; treat that as unsupported
    // so callers can degrade instead of failing the extension.
    return { status: 'unsupported' }
  }

  const response = settled.value.response
  if (response.action === 'accept') {
    const content = response.content as Record<string, unknown> | null | undefined
    return { status: 'accept', value: content?.[ELICITATION_FIELD] }
  }
  return { status: response.action === 'decline' ? 'decline' : 'cancel' }
}

type PermissionChoiceOutcome = { status: 'value'; value: string } | { status: 'none' } | { status: 'no-response' }

/**
 * Translate an elicitation result into a dialog outcome.
 *
 * Returns `null` when the client could not handle the elicitation, so callers can fall
 * back to another mechanism.
 */
function elicitationOutcome(result: ElicitOutcome, accept: (value: unknown) => DialogOutcome): DialogOutcome | null {
  switch (result.status) {
    case 'accept':
      return accept(result.value)
    case 'unsupported':
      return null
    case 'timeout':
      return { kind: 'no-response' }
    default:
      return { kind: 'cancelled' }
  }
}

/** Represent a choice list as an ACP permission request (pre-elicitation clients). */
async function permissionChoice(
  deps: ExtensionUiBridgeDeps,
  ev: PiRpcEvent,
  options: string[],
  timeoutMs: number | undefined
): Promise<PermissionChoiceOutcome> {
  const permissionOptions: PermissionOption[] = options.map((name, index) => ({
    optionId: `${CHOICE_OPTION_PREFIX}${index}`,
    name,
    kind: 'allow_once'
  }))

  const settled = await raceTimeout(requestExtensionPermission(deps, ev, permissionOptions), timeoutMs)
  if (settled.timedOut) return { status: 'no-response' }

  const selected = settled.value
  if (selected === null || selected.outcome.outcome === 'cancelled') return { status: 'none' }

  const index = optionIndex(selected.outcome.optionId)
  if (index === null) return { status: 'none' }

  const value = options.at(index)
  return value === undefined ? { status: 'none' } : { status: 'value', value }
}

async function requestExtensionPermission(
  deps: ExtensionUiBridgeDeps,
  ev: PiRpcEvent,
  options: PermissionOption[]
): Promise<Awaited<ReturnType<AgentSideConnection['requestPermission']>> | null> {
  const id = stringProp(ev, 'id')
  if (!id) return null

  try {
    return await deps.conn.requestPermission({
      sessionId: deps.sessionId,
      toolCall: extensionUiToolCall(id, ev),
      options
    })
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Degradation messages
// ---------------------------------------------------------------------------

function declinedBySettings(deps: ExtensionUiBridgeDeps, method: string, title: string): DialogOutcome {
  deps.emit({
    sessionUpdate: 'agent_message_chunk',
    content: {
      type: 'text',
      text: `Pi requested a "${method}" dialog (${title}), but extension dialogs are disabled by pi-acp settings (\`piAcp.extensionUi = "off"\`). The request was declined; the session is still usable.`
    }
  })
  return { kind: 'cancelled' }
}

function textDialogUnsupported(deps: ExtensionUiBridgeDeps, method: string, title: string): DialogOutcome {
  deps.emit({
    sessionUpdate: 'agent_message_chunk',
    content: {
      type: 'text',
      text: [
        `Pi requested a "${method}" dialog (${title}), but this ACP client cannot show free-form text input.`,
        'The request was declined, so the extension sees a cancelled dialog.',
        'Use a client that supports ACP form elicitation (e.g. Zed), or run the command in the pi TUI.'
      ].join(' ')
    }
  })
  return { kind: 'cancelled' }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Derive the ACP client capabilities we care about. */
export function readExtensionUiCapabilities(capabilities: ClientCapabilities | undefined | null): {
  supportsElicitationForm: boolean
} {
  return { supportsElicitationForm: Boolean(capabilities?.elicitation?.form) }
}

function dialogTitle(ev: PiRpcEvent, method: string): string {
  return stringProp(ev, 'title') ?? `Pi ${method}`
}

function extensionUiToolCall(id: string, ev: PiRpcEvent) {
  const method = stringProp(ev, 'method') ?? 'ui'
  const title = stringProp(ev, 'title') ?? `Pi ${method}`
  const rawInput: Record<string, unknown> = { method }

  for (const key of EXTENSION_UI_RAW_INPUT_KEYS) {
    if (Object.hasOwn(ev, key)) rawInput[key] = ev[key]
  }

  return {
    toolCallId: `pi-ui-${id}`,
    title,
    kind: 'other' as const,
    status: 'pending' as const,
    rawInput
  }
}

function stringProp(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' ? value : null
}

function numberProp(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function optionIndex(optionId: string): number | null {
  if (!optionId.startsWith(CHOICE_OPTION_PREFIX)) return null

  const rawIndex = optionId.slice(CHOICE_OPTION_PREFIX.length)
  if (!rawIndex) return null

  const index = Number(rawIndex)
  return Number.isSafeInteger(index) && index >= 0 && String(index) === rawIndex ? index : null
}

/**
 * Wait for `promise` but give up after `ms`. The losing promise's rejection is swallowed
 * so a late client response cannot become an unhandled rejection.
 */
async function raceTimeout<T>(
  promise: Promise<T>,
  ms: number | undefined
): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
  if (!ms) {
    return { timedOut: false, value: await promise }
  }

  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<{ timedOut: true }>(resolve => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms)
  })

  try {
    return await Promise.race([promise.then(value => ({ timedOut: false as const, value })), timeout])
  } finally {
    if (timer) clearTimeout(timer)
    void promise.catch(() => {})
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
