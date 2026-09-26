import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()

const PLUGIN_DIR =
  path.join(ROOT, 'plugins')

export const plugins =
  new Map()

export const messageListeners =
  []

export const groupListeners =
  []

/*
 * ==============================
 * SPECIAL LISTENER CHECK
 * ==============================
 */

function isSpecialListener(pluginObj) {
  if (
    typeof pluginObj?.command !== 'string'
  ) {
    return false
  }

  return (
    pluginObj.command.startsWith('__') &&
    pluginObj.command.endsWith('_listener')
  )
}

/*
 * ==============================
 * REGISTER PLUGIN
 * ==============================
 */

function registerPluginObject(
  pluginObj,
  file,
  targetPlugins,
  targetMessageListeners,
  targetGroupListeners
) {
  if (
    !pluginObj ||
    typeof pluginObj !== 'object'
  ) {
    return
  }

  const specialListener =
    isSpecialListener(pluginObj)

  /*
   * Store plugin filename
   */
  try {
    Object.defineProperty(
      pluginObj,
      '__file',
      {
        value: file,
        writable: true,
        configurable: true,
        enumerable: false
      }
    )
  } catch {}

  /*
   * ==============================
   * GROUP LISTENER
   * ==============================
   *
   * Any plugin with:
   *
   * isGroupEvent: true
   *
   * will be registered here.
   *
   * This fixes plugins such as:
   *
   * __pdm_listener
   * __welcome_listener
   *
   * even if they have a command property.
   */

  const isGroupListener =
    pluginObj.isGroupEvent === true ||

    pluginObj.command ===
      '__welcome_listener' ||

    pluginObj.type === 'welcome' ||

    (
      typeof pluginObj.run === 'function' &&
      !pluginObj.command &&
      pluginObj.isGroupEvent
    )

  if (
    isGroupListener
  ) {
    if (
      !targetGroupListeners.includes(
        pluginObj
      )
    ) {
      targetGroupListeners.push(
        pluginObj
      )
    }
  }

  /*
   * ==============================
   * MESSAGE LISTENER
   * ==============================
   */

  const isMessageListener =
    (
      specialListener &&
      !isGroupListener
    ) ||

    pluginObj.on === 'text' ||

    typeof pluginObj.on === 'function'

  if (
    isMessageListener &&
    !isGroupListener
  ) {
    if (
      !targetMessageListeners.includes(
        pluginObj
      )
    ) {
      targetMessageListeners.push(
        pluginObj
      )
    }
  }

  /*
   * ==============================
   * COMMAND PLUGIN
   * ==============================
   *
   * Special listeners beginning with
   * "__" are NOT registered as commands.
   */

  if (
    pluginObj.command &&
    !specialListener
  ) {
    const commandNames =
      Array.isArray(
        pluginObj.command
      )
        ? pluginObj.command
        : [pluginObj.command]

    for (
      const command of commandNames
    ) {
      if (
        !command
      ) {
        continue
      }

      targetPlugins.set(
        String(command)
          .toLowerCase()
          .trim(),
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
  /*
   * Create plugins directory
   * if it doesn't exist.
   */

  if (
    !fs.existsSync(
      PLUGIN_DIR
    )
  ) {
    fs.mkdirSync(
      PLUGIN_DIR,
      {
        recursive: true
      }
    )
  }

  const newPlugins =
    new Map()

  const newMessageListeners =
    []

  const newGroupListeners =
    []

  /*
   * Only JavaScript plugins
   */

  const entries =
    fs
      .readdirSync(
        PLUGIN_DIR
      )
      .filter(
        (file) =>
          file.endsWith('.js')
      )

  /*
   * ==============================
   * IMPORT EVERY PLUGIN
   * ==============================
   */

  for (
    const file of entries
  ) {
    try {
      const filePath =
        path.join(
          PLUGIN_DIR,
          file
        )

      /*
       * Cache-busting query
       * allows plugin reloads.
       */

      const url =
        `${pathToFileURL(
          filePath
        ).href}?v=${Date.now()}`

      const mod =
        await import(url)

      /*
       * Support:
       *
       * export default {}
       * export const plugin = {}
       * export const listener = {}
       */

      const exports = [
        mod.default,
        ...Object.values(mod)
      ]

      const processed =
        new Set()

      /*
       * Register every exported
       * plugin object only once.
       */

      for (
        const item of exports
      ) {
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
        error?.message || error
      )
    }
  }

  /*
   * ==============================
   * UPDATE GLOBAL MAPS
   * ==============================
   */

  plugins.clear()

  for (
    const [
      command,
      plugin
    ] of newPlugins
  ) {
    plugins.set(
      command,
      plugin
    )
  }

  /*
   * ==============================
   * MESSAGE LISTENERS
   * ==============================
   */

  messageListeners.length = 0

  messageListeners.push(
    ...newMessageListeners
  )

  /*
   * ==============================
   * GROUP LISTENERS
   * ==============================
   */

  groupListeners.length = 0

  groupListeners.push(
    ...newGroupListeners
  )

  /*
   * ==============================
   * SUMMARY
   * ==============================
   */

  console.log(
    `\n[SUMMARY] Loaded: ${
      plugins.size
    } commands, ${
      messageListeners.length
    } message listeners, and ${
      groupListeners.length
    } group listeners.\n`
  )

  /*
   * Debug group listeners
   */

  if (
    groupListeners.length
  ) {
    console.log(
      '[GROUP LISTENERS]'
    )

    for (
      const listener of
      groupListeners
    ) {
      console.log(
        `  ✓ ${
          listener.command ||
          listener.type ||
          listener.__file ||
          'unknown'
        }`
      )
    }

    console.log('')
  }

  return {
    commands:
      plugins.size,

    messageListeners:
      messageListeners.length,

    groupListeners:
      groupListeners.length
  }
}