import test from 'node:test'
import assert from 'node:assert/strict'
import { createExtensionUiBridge, readExtensionUiCapabilities } from '../../src/acp/extension-ui.js'
import type { ExtensionUiMode } from '../../src/acp/acp-settings.js'
import { asAgentConn, FakeAgentSideConnection, FakePiRpcProcess } from '../helpers/fakes.js'

function makeBridge(opts: { mode?: ExtensionUiMode; supportsElicitationForm?: boolean; debug?: boolean } = {}) {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const bridge = createExtensionUiBridge({
    conn: asAgentConn(conn),
    sessionId: 's1',
    proc: proc as any,
    mode: opts.mode ?? 'auto',
    supportsElicitationForm: opts.supportsElicitationForm ?? true,
    emit: update => {
      conn.updates.push({ sessionId: 's1', update } as any)
    },
    debug: opts.debug
  })
  return { conn, proc, bridge }
}

const textOf = (update: any): string => update?.content?.text ?? ''

test('readExtensionUiCapabilities: only form elicitation counts', () => {
  assert.equal(readExtensionUiCapabilities({ elicitation: { form: {} } }).supportsElicitationForm, true)
  assert.equal(readExtensionUiCapabilities({ elicitation: {} }).supportsElicitationForm, false)
  assert.equal(readExtensionUiCapabilities(null).supportsElicitationForm, false)
  assert.equal(readExtensionUiCapabilities(undefined).supportsElicitationForm, false)
})

test('extension-ui: select prefers a form elicitation with the option list', async () => {
  const { conn, proc, bridge } = makeBridge()
  conn.nextElicitationResponse = { action: 'accept', content: { value: 'Beta' } }

  const handled = await bridge.handle({
    type: 'extension_ui_request',
    id: 'ui-1',
    method: 'select',
    title: 'Pick one',
    options: ['Alpha', 'Beta']
  })

  assert.equal(handled, true)
  assert.equal(conn.permissionRequests.length, 0)
  assert.deepEqual(conn.elicitationRequests, [
    {
      mode: 'form',
      sessionId: 's1',
      message: 'Pick one',
      requestedSchema: {
        type: 'object',
        properties: { value: { type: 'string', title: 'Pick one', enum: ['Alpha', 'Beta'] } },
        required: ['value']
      }
    }
  ])
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-1', value: 'Beta' }])
})

test('extension-ui: select falls back to a permission choice list when the client cannot elicit', async () => {
  const { conn, proc, bridge } = makeBridge({ supportsElicitationForm: false })
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'choice-1' } }

  await bridge.handle({
    type: 'extension_ui_request',
    id: 'ui-2',
    method: 'select',
    title: 'Pick one',
    options: ['Alpha', 'Beta']
  })

  assert.equal(conn.elicitationRequests.length, 0)
  assert.deepEqual((conn.permissionRequests[0] as any).options, [
    { optionId: 'choice-0', name: 'Alpha', kind: 'allow_once' },
    { optionId: 'choice-1', name: 'Beta', kind: 'allow_once' }
  ])
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-2', value: 'Beta' }])
})

test('extension-ui: select falls back to permissions when elicitation is unsupported at runtime', async () => {
  const { conn, proc, bridge } = makeBridge()
  conn.nextElicitationError = new Error('Method not found')
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'choice-0' } }

  await bridge.handle({
    type: 'extension_ui_request',
    id: 'ui-3',
    method: 'select',
    title: 'Pick one',
    options: ['Alpha', 'Beta']
  })

  assert.equal(conn.permissionRequests.length, 1)
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-3', value: 'Alpha' }])
})

test('extension-ui: select declines cleanly when the elicitation is cancelled', async () => {
  const { conn, proc, bridge } = makeBridge()
  conn.nextElicitationResponse = { action: 'cancel' }

  await bridge.handle({
    type: 'extension_ui_request',
    id: 'ui-4',
    method: 'select',
    title: 'Pick one',
    options: ['Alpha']
  })

  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-4', cancelled: true }])
})

test('extension-ui: confirm uses a boolean form field and honours the answer', async () => {
  const { conn, proc, bridge } = makeBridge()
  conn.nextElicitationResponse = { action: 'accept', content: { value: false } }

  await bridge.handle({
    type: 'extension_ui_request',
    id: 'ui-5',
    method: 'confirm',
    title: 'Clear session?',
    message: 'All messages will be lost.'
  })

  const request = conn.elicitationRequests[0] as any
  assert.equal(request.mode, 'form')
  assert.equal(request.message, 'Clear session?\n\nAll messages will be lost.')
  assert.deepEqual(request.requestedSchema.properties.value, {
    type: 'boolean',
    title: 'Clear session?',
    description: 'All messages will be lost.',
    default: true
  })
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-5', confirmed: false }])
})

test('extension-ui: input is bridged through elicitation (goal drafting depends on this)', async () => {
  const { conn, proc, bridge } = makeBridge()
  conn.nextElicitationResponse = { action: 'accept', content: { value: 'my answer' } }

  await bridge.handle({
    type: 'extension_ui_request',
    id: 'ui-6',
    method: 'input',
    title: 'Enter a value',
    placeholder: 'type something...'
  })

  assert.deepEqual((conn.elicitationRequests[0] as any).requestedSchema.properties.value, {
    type: 'string',
    title: 'Enter a value',
    description: 'type something...'
  })
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-6', value: 'my answer' }])
})

test('extension-ui: editor prefills the form and returns the edited text', async () => {
  const { conn, proc, bridge } = makeBridge()
  conn.nextElicitationResponse = { action: 'accept', content: { value: 'edited' } }

  await bridge.handle({
    type: 'extension_ui_request',
    id: 'ui-7',
    method: 'editor',
    title: 'Edit text',
    prefill: 'line 1\nline 2'
  })

  assert.equal((conn.elicitationRequests[0] as any).requestedSchema.properties.value.default, 'line 1\nline 2')
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-7', value: 'edited' }])
})

test('extension-ui: input without elicitation explains the degradation and cancels', async () => {
  const { conn, proc, bridge } = makeBridge({ supportsElicitationForm: false })

  await bridge.handle({ type: 'extension_ui_request', id: 'ui-8', method: 'input', title: 'Enter name' })

  assert.equal(conn.elicitationRequests.length, 0)
  assert.equal(conn.permissionRequests.length, 0)
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-8', cancelled: true }])
  assert.equal(conn.updates.length, 1)
  assert.match(textOf(conn.updates[0]!.update), /cannot show free-form text input/)
  assert.match(textOf(conn.updates[0]!.update), /pi TUI/)
})

test('extension-ui: mode "permission" skips elicitation and never prompts for text', async () => {
  const { conn, proc, bridge } = makeBridge({ mode: 'permission' })
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'choice-1' } }

  await bridge.handle({
    type: 'extension_ui_request',
    id: 'ui-9',
    method: 'select',
    title: 'Pick one',
    options: ['Alpha', 'Beta']
  })
  await bridge.handle({ type: 'extension_ui_request', id: 'ui-10', method: 'input', title: 'Enter name' })

  assert.equal(conn.elicitationRequests.length, 0)
  assert.equal(conn.permissionRequests.length, 1)
  assert.deepEqual(proc.extensionUiResponses, [
    { id: 'ui-9', value: 'Beta' },
    { id: 'ui-10', cancelled: true }
  ])
})

test('extension-ui: mode "off" declines every dialog and points at the setting', async () => {
  const { conn, proc, bridge } = makeBridge({ mode: 'off' })

  await bridge.handle({
    type: 'extension_ui_request',
    id: 'ui-11',
    method: 'select',
    title: 'Pick one',
    options: ['Alpha']
  })
  await bridge.handle({
    type: 'extension_ui_request',
    id: 'ui-12',
    method: 'confirm',
    title: 'Continue?'
  })

  assert.equal(conn.elicitationRequests.length, 0)
  assert.equal(conn.permissionRequests.length, 0)
  assert.deepEqual(proc.extensionUiResponses, [
    { id: 'ui-11', cancelled: true },
    { id: 'ui-12', cancelled: true }
  ])
  assert.equal(conn.updates.length, 2)
  assert.match(textOf(conn.updates[0]!.update), /extensionUi = "off"/)
})

test('extension-ui: fire-and-forget requests never get a response', async () => {
  const { conn, proc, bridge } = makeBridge()

  await bridge.handle({
    type: 'extension_ui_request',
    id: 'ui-13',
    method: 'notify',
    message: 'Command blocked by user',
    notifyType: 'warning'
  })
  await bridge.handle({
    type: 'extension_ui_request',
    id: 'ui-14',
    method: 'setStatus',
    statusKey: 'goal',
    statusText: 'Turn 3 running...'
  })
  await bridge.handle({
    type: 'extension_ui_request',
    id: 'ui-15',
    method: 'setWidget',
    widgetKey: 'goal',
    widgetLines: ['a', 'b']
  })

  // Only the notification is surfaced; status/widget churn stays out of the chat.
  assert.deepEqual(proc.extensionUiResponses, [])
  assert.equal(conn.updates.length, 1)
  assert.equal(textOf(conn.updates[0]!.update), 'Command blocked by user')
  assert.deepEqual((conn.updates[0]!.update as any)._meta, { piAcp: { notify: { level: 'warning' } } })
})

test('extension-ui: debug mode echoes status/widget updates', async () => {
  const { conn, proc, bridge } = makeBridge({ debug: true })

  await bridge.handle({
    type: 'extension_ui_request',
    id: 'ui-16',
    method: 'setStatus',
    statusKey: 'goal',
    statusText: 'Turn 3 running...'
  })
  await bridge.handle({
    type: 'extension_ui_request',
    id: 'ui-17',
    method: 'setWidget',
    widgetKey: 'goal',
    widgetLines: ['a', 'b']
  })

  assert.deepEqual(proc.extensionUiResponses, [])
  assert.equal(conn.updates.length, 2)
  assert.match(textOf(conn.updates[0]!.update), /\[pi-acp debug\] setStatus: goal = Turn 3 running\.\.\./)
  assert.match(textOf(conn.updates[1]!.update), /\[pi-acp debug\] setWidget: goal: 2 line\(s\)/)
})

test('extension-ui: unknown dialog methods cancel so the extension never hangs', async () => {
  const { conn, proc, bridge } = makeBridge()

  const handled = await bridge.handle({
    type: 'extension_ui_request',
    id: 'ui-18',
    method: 'brand-new-dialog',
    title: 'Future thing'
  })

  assert.equal(handled, true)
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-18', cancelled: true }])
  assert.match(textOf(conn.updates[0]!.update), /unrecognized dialog method "brand-new-dialog"/)
})

test('extension-ui: pi `custom` UI is explained rather than silently dropped', async () => {
  const { proc, bridge, conn } = makeBridge()

  await bridge.handle({ type: 'extension_ui_request', id: 'ui-19', method: 'custom', title: 'Questionnaire' })

  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-19', cancelled: true }])
  assert.match(textOf(conn.updates[0]!.update), /already returns undefined in RPC mode/)
})

test('extension-ui: honours pi dialog timeouts without answering after expiry', async () => {
  const { conn, proc, bridge } = makeBridge()
  ;(conn as any).unstable_createElicitation = () => new Promise(() => {})

  await bridge.handle({
    type: 'extension_ui_request',
    id: 'ui-20',
    method: 'input',
    title: 'Enter a value',
    timeout: 20
  })

  // pi auto-resolves its own side once `timeout` elapses, so no response must be sent.
  assert.deepEqual(proc.extensionUiResponses, [])
})

test('extension-ui: a throwing elicitation degrades to cancel with an explanation', async () => {
  const { conn, proc, bridge } = makeBridge()
  conn.nextElicitationError = new Error('boom')

  await bridge.handle({
    type: 'extension_ui_request',
    id: 'ui-21',
    method: 'input',
    title: 'Enter a value'
  })

  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-21', cancelled: true }])
  assert.equal(conn.updates.length, 1)
  assert.match(textOf(conn.updates[0]!.update), /cannot show free-form text input/)
})

test('extension-ui: requests without an id are ignored', async () => {
  const { proc, bridge } = makeBridge()
  assert.equal(await bridge.handle({ type: 'extension_ui_request', method: 'select' }), false)
  assert.deepEqual(proc.extensionUiResponses, [])
})
