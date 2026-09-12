import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_ACP_SETTINGS,
  ENV_EXTENSION_COMMANDS,
  ENV_EXTENSION_UI,
  parseBooleanSetting,
  parseExtensionUiMode,
  resolveAcpSettings
} from '../../src/acp/acp-settings.js'

function withAgentDir(settings: unknown, fn: (dir: string) => void): void {
  const prev = process.env.PI_CODING_AGENT_DIR
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-settings-'))
  if (settings !== undefined) {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8')
  }
  process.env.PI_CODING_AGENT_DIR = dir
  try {
    fn(dir)
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prev
  }
}

test('parseBooleanSetting accepts booleans and common env spellings', () => {
  assert.equal(parseBooleanSetting(true), true)
  assert.equal(parseBooleanSetting(false), false)
  assert.equal(parseBooleanSetting('1'), true)
  assert.equal(parseBooleanSetting('TRUE'), true)
  assert.equal(parseBooleanSetting('on'), true)
  assert.equal(parseBooleanSetting('0'), false)
  assert.equal(parseBooleanSetting('Off'), false)
  assert.equal(parseBooleanSetting('maybe'), undefined)
  assert.equal(parseBooleanSetting(undefined), undefined)
  assert.equal(parseBooleanSetting(1), undefined)
})

test('parseExtensionUiMode accepts only known modes', () => {
  assert.equal(parseExtensionUiMode('auto'), 'auto')
  assert.equal(parseExtensionUiMode(' PERMISSION '), 'permission')
  assert.equal(parseExtensionUiMode('off'), 'off')
  assert.equal(parseExtensionUiMode('nope'), undefined)
  assert.equal(parseExtensionUiMode(undefined), undefined)
})

test('resolveAcpSettings: extension commands are advertised by default', () => {
  withAgentDir(undefined, () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-cwd-'))
    assert.deepEqual(resolveAcpSettings(cwd, {}), DEFAULT_ACP_SETTINGS)
    assert.equal(DEFAULT_ACP_SETTINGS.extensionCommands, true)
    assert.equal(DEFAULT_ACP_SETTINGS.extensionUi, 'auto')
  })
})

test('resolveAcpSettings: project `piAcp` block overrides global, env overrides both', () => {
  withAgentDir({ piAcp: { extensionCommands: false, extensionUi: 'permission' } }, () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-cwd-'))
    mkdirSync(join(cwd, '.pi'), { recursive: true })
    writeFileSync(join(cwd, '.pi', 'settings.json'), JSON.stringify({ piAcp: { extensionCommands: true } }), 'utf-8')

    assert.deepEqual(resolveAcpSettings(cwd, {}), {
      extensionCommands: true,
      extensionUi: 'permission'
    })

    assert.deepEqual(resolveAcpSettings(cwd, { [ENV_EXTENSION_COMMANDS]: '0', [ENV_EXTENSION_UI]: 'off' }), {
      extensionCommands: false,
      extensionUi: 'off'
    })
  })
})

test('resolveAcpSettings: invalid values fall back instead of throwing', () => {
  withAgentDir({ piAcp: { extensionCommands: 'not-a-bool', extensionUi: 'nonsense' } }, () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-cwd-'))
    assert.deepEqual(resolveAcpSettings(cwd, {}), DEFAULT_ACP_SETTINGS)
    assert.deepEqual(resolveAcpSettings(cwd, { [ENV_EXTENSION_COMMANDS]: 'garbage' }), DEFAULT_ACP_SETTINGS)
  })
})
