import { getMergedSettings } from './pi-settings.js'

/**
 * pi-acp's own settings, resolved from (lowest to highest precedence):
 *
 * 1. {@link DEFAULT_ACP_SETTINGS}
 * 2. `piAcp` block in `~/.pi/agent/settings.json`
 * 3. `piAcp` block in `<cwd>/.pi/settings.json`
 * 4. environment variables
 *
 * Example settings.json:
 *
 * ```json
 * {
 *   "piAcp": {
 *     "extensionCommands": true,
 *     "extensionUi": "auto"
 *   }
 * }
 * ```
 */

/**
 * How extension dialog requests (`select`, `confirm`, `input`, `editor`) are surfaced to
 * the user.
 *
 * - `auto` (default): use an ACP elicitation form when the client supports it, otherwise
 *   fall back to `permission` for the methods that can be represented as a choice list.
 * - `permission`: always use `session/request_permission` choice lists. Only `select` and
 *   `confirm` can be represented; `input` and `editor` are declined with an explanation.
 * - `off`: never prompt. Dialog requests are declined with an explanation.
 */
export type ExtensionUiMode = 'auto' | 'permission' | 'off'

export type AcpSettings = {
  /**
   * Advertise commands registered by pi extensions (e.g. `/goal` from `pi-goal-x`) in the
   * ACP `available_commands_update`. Extension commands execute through pi's RPC
   * `prompt` command either way; this only controls whether the client's `/` menu lists
   * them.
   */
  extensionCommands: boolean
  /** How extension dialogs are surfaced. */
  extensionUi: ExtensionUiMode
}

export const DEFAULT_ACP_SETTINGS: AcpSettings = {
  extensionCommands: true,
  extensionUi: 'auto'
}

export const ENV_EXTENSION_COMMANDS = 'PI_ACP_EXTENSION_COMMANDS'
export const ENV_EXTENSION_UI = 'PI_ACP_EXTENSION_UI'

/** When truthy, unrenderable fire-and-forget requests are echoed into the conversation. */
export const ENV_EXTENSION_UI_DEBUG = 'PI_ACP_EXTENSION_UI_DEBUG'

/** Settings key inside pi's `settings.json` that carries pi-acp options. */
export const ACP_SETTINGS_KEY = 'piAcp'

const EXTENSION_UI_MODES: readonly ExtensionUiMode[] = ['auto', 'permission', 'off']

/** Parse a boolean from a settings value or an env var string. Returns undefined when unset/invalid. */
export function parseBooleanSetting(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return undefined

  switch (value.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
    case 'enabled':
      return true
    case '0':
    case 'false':
    case 'no':
    case 'off':
    case 'disabled':
      return false
    default:
      return undefined
  }
}

/** Parse an {@link ExtensionUiMode}. Returns undefined when unset/invalid. */
export function parseExtensionUiMode(value: unknown): ExtensionUiMode | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  return (EXTENSION_UI_MODES as readonly string[]).includes(normalized) ? (normalized as ExtensionUiMode) : undefined
}

function pick(settings: Record<string, unknown>, key: string): unknown {
  const block = settings[ACP_SETTINGS_KEY]
  if (!block || typeof block !== 'object' || Array.isArray(block)) return undefined
  return (block as Record<string, unknown>)[key]
}

/**
 * Resolve the effective pi-acp settings for a session working directory.
 *
 * `env` is injectable so tests (and future embedded hosts) do not have to mutate
 * `process.env`.
 */
export function resolveAcpSettings(cwd: string, env: NodeJS.ProcessEnv = process.env): AcpSettings {
  const settings = getMergedSettings(cwd)

  const extensionCommands =
    parseBooleanSetting(env[ENV_EXTENSION_COMMANDS]) ??
    parseBooleanSetting(pick(settings, 'extensionCommands')) ??
    DEFAULT_ACP_SETTINGS.extensionCommands

  const extensionUi =
    parseExtensionUiMode(env[ENV_EXTENSION_UI]) ??
    parseExtensionUiMode(pick(settings, 'extensionUi')) ??
    DEFAULT_ACP_SETTINGS.extensionUi

  return { extensionCommands, extensionUi }
}
