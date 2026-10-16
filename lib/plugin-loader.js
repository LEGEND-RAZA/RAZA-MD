
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const PLUGIN_DIR = path.join(ROOT, 'plugins')

export const plugins = new Map()
export const messageListeners = []
export const groupListeners = []

/*
 * ==============================
 * SPECIAL LISTENER CHECK
 * ==============================
 */

function isSpecialListener(pluginObj) {
  if (typeof pluginObj?.command !== 'string') {
    return false
  }

  return (
    pluginObj.command.startsWith('__') &&
    pluginObj.command.endsWith('_listener')
  )
}

/*
 * ==============================
 * FILE PRIORITY
 * ==============================
 *
 * Prefer plugins/welcome.js when
 * duplicate welcome listeners exist.
 */

function isPreferredListenerFile(file, command) {
  if (command !== '__welcome_listener') {
    return false
  }

  return path.basename(file || '').toLowerCase() === 'welcome.js'
}

/*
 * ==============================
 * REGISTER GROUP LISTENER
 * ==============================
 *
 * A special listener command may be
 * registered only once, even if
 * multiple files export that command.
 */

function registerGroupListener(
  pluginObj,
  file,
  targetGroupListeners
) {
  const command = isSpecialListener(pluginObj)
    ? pluginObj.command
    : null

  if (!command) {
    if (!targetGroupListeners.includes(pluginObj)) {
      targetGroupListeners.push(pluginObj)
    }
    return
  }

  const existingIndex = targetGroupListeners.findIndex(
    listener => listener?.command === command
  )

  if (existingIndex === -1) {
    targetGroupListeners.push(pluginObj)
    return
  }

  const existing = targetGroupListeners[existingIndex]
  const existingFile = existing.__file || ''
  const currentPreferred = isPreferredListenerFile(file, command)
  const existingPreferred = isPreferredListenerFile(
    existingFile,
    command
  )

  if (currentPreferred && !existingPreferred) {
    targetGroupListeners[existingIndex] = pluginObj

    console.warn(
      `[PLUGIN] Replaced duplicate ${command} from ` +
      `${path.basename(existingFile)} with ${path.basename(file)}`
    )

    return
  }

  console.warn(
    `[PLUGIN] Skipped duplicate ${command} from ${file}; ` +
    `using ${path.basename(existingFile) || 'previous listener'}`
  )
}

/*
 * ==============================
 * REGISTER PLUGIN OBJECT
 * ==============================
 */

function registerPluginObject(
  pluginObj,
  file,
  targetPlugins,
  targetMessageListeners,
  targetGroupListeners
) {
  if (!pluginObj || typeof pluginObj !== 'object') {
    return
  }

  const specialListener = isSpecialListener(pluginObj)

  try {
    Object.defineProperty(pluginObj, '__file', {
      value: file,
      writable: true,
      configurable: true,
      enumerable: false
    })
  } catch {}

  /*
   * GROUP LISTENER
   */

  const isGroupListener =
    pluginObj.isGroupEvent === true ||
    pluginObj.command === '__welcome_listener' ||
    pluginObj.type === 'welcome' ||
    (
      typeof pluginObj.run === 'function' &&
      !pluginObj.command &&
      pluginObj.isGroupEvent
    )

  if (isGroupListener) {
    registerGroupListener(
      pluginObj,
      file,
      targetGroupListeners
    )
  }

  /*
   * MESSAGE LISTENER
   */

  const isMessageListener =
    (
      specialListener &&
      !isGroupListener
    ) ||
    pluginObj.on === 'text' ||
    typeof pluginObj.on === 'function'

  if (isMessageListener && !isGroupListener) {
    if (!targetMessageListeners.includes(pluginObj)) {
      targetMessageListeners.push(pluginObj)
    }
  }

  /*
   * COMMAND PLUGIN
   *
   * Special listeners are not commands.
   */

  if (pluginObj.command && !specialListener) {
    const commandNames = Array.isArray(pluginObj.command)
      ? pluginObj.command
      : [pluginObj.command]

    for (const command of commandNames) {
      if (!command) continue

      targetPlugins.set(
        String(command).toLowerCase().trim(),
        pluginObj
      )
    }
  }
}

/*
 * ==============================
 * LOAD PLUGINS
 * ==============================
 */

export async function loadPlugins() {
  if (!fs.existsSync(PLUGIN_DIR)) {
    fs.mkdirSync(PLUGIN_DIR, { recursive: true })
  }

  const newPlugins = new Map()
  const newMessageListeners = []
  const newGroupListeners = []

  const entries = fs
    .readdirSync(PLUGIN_DIR)
    .filter(file => file.endsWith('.js'))
    .sort((a, b) => {
      // Load welcome.js first so it wins if duplicates exist.
      const aWelcome = a.toLowerCase() === 'welcome.js'
      const bWelcome = b.toLowerCase() === 'welcome.js'

      if (aWelcome && !bWelcome) return -1
      if (!aWelcome && bWelcome) return 1

      return a.localeCompare(b)
    })

  for (const file of entries) {
    try {
      const filePath = path.join(PLUGIN_DIR, file)
      const url =
        `${pathToFileURL(filePath).href}?v=${Date.now()}`

      const mod = await import(url)

      const exports = [
        mod.default,
        ...Object.values(mod)
      ]

      const processed = new Set()

      for (const item of exports) {
        if (
          !item ||
          typeof item !== 'object' ||
          processed.has(item)
        ) {
          continue
        }

        processed.add(item)

        registerPluginObject(
          item,
          file,
          newPlugins,
          newMessageListeners,
          newGroupListeners
        )
      }
    } catch (error) {
      console.error(
        `[-] Failed to load plugin ${file}:`,
        error?.stack || error?.message || error
      )
    }
  }

  /*
   * UPDATE COMMAND MAP
   */

  plugins.clear()

  for (const [command, plugin] of newPlugins) {
    plugins.set(command, plugin)
  }

  /*
   * UPDATE MESSAGE LISTENERS
   */

  messageListeners.length = 0
  messageListeners.push(...newMessageListeners)

  /*
   * UPDATE GROUP LISTENERS
   */

  groupListeners.length = 0
  groupListeners.push(...newGroupListeners)

  /*
   * SUMMARY
   */

  console.log(
    `\n[SUMMARY] Loaded: ${plugins.size} commands, ` +
    `${messageListeners.length} message listeners, and ` +
    `${groupListeners.length} group listeners.\n`
  )

  if (groupListeners.length) {
    console.log('[GROUP LISTENERS]')

    for (const listener of groupListeners) {
      console.log(
        `  ✓ ${listener.command || listener.type || listener.__file || 'unknown'}` +
        ` [file: ${listener.__file || 'unknown'}]`
      )
    }

    console.log('')
  }

  return {
    commands: plugins.size,
    messageListeners: messageListeners.length,
    groupListeners: groupListeners.length
  }
}
