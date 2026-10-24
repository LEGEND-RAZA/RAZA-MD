import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const LOADER_DIR = path.dirname(fileURLToPath(import.meta.url))

// A plugin that has not finished importing after this long is skipped.
const IMPORT_TIMEOUT_MS = Number(process.env.PLUGIN_IMPORT_TIMEOUT_MS) || 20000

export const plugins = new Map()
export const messageListeners = []
export const groupListeners = []
export const setupHooks = []

/*
 * FIX: the plugins folder used to be process.cwd() + /plugins. Start the bot
 * from any other folder and it silently loaded 0 commands. Now it also looks
 * next to this file (lib/../plugins). Set PLUGIN_DIR to force a folder.
 */
function resolvePluginDir() {
  const candidates = [
    process.env.PLUGIN_DIR && path.resolve(process.env.PLUGIN_DIR),
    path.join(process.cwd(), 'plugins'),
    path.resolve(LOADER_DIR, '..', 'plugins')
  ].filter(Boolean)

  return candidates.find(dir => fs.existsSync(dir)) || candidates[candidates.length - 1]
}

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
      ms
    )
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

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
 */

function registerGroupListener(pluginObj, file, targetGroupListeners) {
  const command = isSpecialListener(pluginObj) ? pluginObj.command : null

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
  const existingPreferred = isPreferredListenerFile(existingFile, command)

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

function registerPluginObject(pluginObj, file, ctx) {
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
   * SETUP HOOK — runs once per socket creation.
   * Used by plugins that need to register custom event listeners
   * (e.g. messages.update for anti-delete).
   *
   * bind() keeps `this` working inside setup(); __file is only for logging.
   */

  if (typeof pluginObj.setup === 'function' && !ctx.seenSetups.has(pluginObj.setup)) {
    ctx.seenSetups.add(pluginObj.setup)
    const hook = pluginObj.setup.bind(pluginObj)
    hook.__file = file
    ctx.setupHooks.push(hook)
  }

  /*
   * GROUP LISTENER
   */

  const isGroupListener =
    pluginObj.isGroupEvent === true ||
    pluginObj.command === '__welcome_listener' ||
    pluginObj.type === 'welcome' ||
    (typeof pluginObj.run === 'function' &&
      !pluginObj.command &&
      pluginObj.isGroupEvent)

  if (isGroupListener) {
    registerGroupListener(pluginObj, file, ctx.groupListeners)
  }

  /*
   * MESSAGE LISTENER
   *
   * Objects that have an emit() method (an exported EventEmitter, for
   * example) are not listeners: calling their on() with message data would
   * throw on every single message.
   */

  const hasOnFunction =
    typeof pluginObj.on === 'function' && typeof pluginObj.emit !== 'function'

  const isMessageListener =
    (specialListener && !isGroupListener) ||
    pluginObj.on === 'text' ||
    hasOnFunction

  if (isMessageListener && !isGroupListener) {
    if (!ctx.messageListeners.includes(pluginObj)) {
      ctx.messageListeners.push(pluginObj)
    }
  }

  /*
   * COMMAND PLUGIN
   */

  if (pluginObj.command && !specialListener) {
    if (typeof pluginObj.run !== 'function') {
      console.warn(`[PLUGIN] ${file}: command "${pluginObj.command}" has no run() function, skipped`)
      return
    }

    const commandNames = Array.isArray(pluginObj.command)
      ? pluginObj.command
      : [pluginObj.command]

    for (const command of commandNames) {
      if (!command) continue

      const name = String(command).toLowerCase().trim()
      if (!name) continue

      const previous = ctx.plugins.get(name)
      if (previous && previous !== pluginObj) {
        console.warn(
          `[PLUGIN] Command "${name}" from ${file} overrides the one from ${previous.__file || 'another plugin'}`
        )
      }

      ctx.plugins.set(name, pluginObj)
    }
  }
}

/*
 * ==============================
 * LOAD PLUGINS
 * ==============================
 */

export async function loadPlugins() {
  const pluginDir = resolvePluginDir()

  if (!fs.existsSync(pluginDir)) {
    fs.mkdirSync(pluginDir, { recursive: true })
  }

  const ctx = {
    plugins: new Map(),
    messageListeners: [],
    groupListeners: [],
    setupHooks: [],
    seenSetups: new Set()
  }

  const entries = fs
    .readdirSync(pluginDir)
    .filter(file => file.endsWith('.js'))
    .sort((a, b) => {
      const aWelcome = a.toLowerCase() === 'welcome.js'
      const bWelcome = b.toLowerCase() === 'welcome.js'
      if (aWelcome && !bWelcome) return -1
      if (!aWelcome && bWelcome) return 1
      return a.localeCompare(b)
    })

  if (!entries.length) {
    console.warn(`[PLUGIN] No .js plugin files found in ${pluginDir}`)
  } else {
    console.log(`[PLUGIN] Loading ${entries.length} file(s) from ${pluginDir}`)
  }

  for (const file of entries) {
    try {
      const filePath = path.join(pluginDir, file)
      const url = `${pathToFileURL(filePath).href}?v=${Date.now()}`

      /*
       * FIX: a plugin that waits on something forever while being imported
       * (top-level await on a DB or network call) used to freeze the whole
       * startup, so the bot never even tried to connect.
       */
      const mod = await withTimeout(import(url), IMPORT_TIMEOUT_MS, `Importing ${file}`)

      const exports = [mod.default, ...Object.values(mod)]
      const processed = new Set()

      for (const item of exports) {
        if (!item || typeof item !== 'object' || processed.has(item)) {
          continue
        }
        processed.add(item)
        registerPluginObject(item, file, ctx)
      }
    } catch (error) {
      console.error(
        `[-] Failed to load plugin ${file}:`,
        error?.stack || error?.message || error
      )
    }
  }

  plugins.clear()
  for (const [command, plugin] of ctx.plugins) {
    plugins.set(command, plugin)
  }

  messageListeners.length = 0
  messageListeners.push(...ctx.messageListeners)

  groupListeners.length = 0
  groupListeners.push(...ctx.groupListeners)

  setupHooks.length = 0
  setupHooks.push(...ctx.setupHooks)

  console.log(
    `\n[SUMMARY] Loaded: ${plugins.size} commands, ` +
    `${messageListeners.length} message listeners, ` +
    `${groupListeners.length} group listeners, ` +
    `${setupHooks.length} setup hooks.\n`
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

  if (setupHooks.length) {
    console.log('[SETUP HOOKS]')
    for (const hook of setupHooks) {
      console.log(`  ✓ setup [file: ${hook.__file || 'unknown'}]`)
    }
    console.log('')
  }

  return {
    commands: plugins.size,
    messageListeners: messageListeners.length,
    groupListeners: groupListeners.length,
    setupHooks: setupHooks.length
  }
}
