import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

function sessionFixture() {
  return {
    sessionId: 'session-1',
    cwd: process.cwd(),
    proc: {
      async getState() {
        return { thinkingLevel: 'medium', model: { provider: 'test', id: 'model' } }
      },
      async getAvailableModels() {
        return { models: [{ provider: 'test', id: 'model', name: 'Model' }] }
      }
    },
    setStartupInfo() {},
    sendStartupInfoIfPending() {}
  }
}

test('PiAcpAgent: advertises ACP additional-directories support', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))

  const result = await agent.initialize({ protocolVersion: 1 } as any)

  assert.ok(result.agentCapabilities)
  assert.deepEqual(result.agentCapabilities.sessionCapabilities, {
    list: {},
    delete: {},
    additionalDirectories: {}
  })
})

test('PiAcpAgent: passes additional workspace roots to a new Pi session', async () => {
  const realSetTimeout = globalThis.setTimeout
  ;(globalThis as any).setTimeout = () => 0 as any

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    const received: any[] = []
    const session = sessionFixture()

    ;(agent as any).sessions = {
      async create(params: unknown) {
        received.push(params)
        return session
      }
    }

    await agent.newSession({
      cwd: process.cwd(),
      additionalDirectories: ['/tmp/backend', '/tmp/mobile'],
      mcpServers: []
    } as any)

    assert.equal(received.length, 1)
    assert.deepEqual(received[0].additionalDirectories, ['/tmp/backend', '/tmp/mobile'])
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
  }
})

test('PiAcpAgent: rejects relative additional workspace roots', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))

  await assert.rejects(
    agent.newSession({ cwd: process.cwd(), additionalDirectories: ['relative/path'], mcpServers: [] } as any)
  )
})
