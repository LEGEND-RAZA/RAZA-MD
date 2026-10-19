
import { getDb, saveDb } from '../database/index.js'

const SETTINGS_FILE = 'status-view-settings.json'

const DEFAULT_SETTINGS = {
  enabled: true
}

async function loadSettings() {
  try {
    const saved = await getDb(SETTINGS_FILE, {})
    return {
      ...DEFAULT_SETTINGS,
      ...(saved && typeof saved === 'object' ? saved : {})
    }
  } catch (error) {
    console.error('[STATUS VIEW] Settings load failed:', error.message)
    return { ...DEFAULT_SETTINGS }
  }
}

async function saveSettings(settings) {
  await saveDb(SETTINGS_FILE, settings)
}

function getPrefix() {
  return process.env.PREFIX || '.'
}

/**
 * Automatically mark incoming WhatsApp Status updates as viewed.
 */
export const statusViewListener = {
  command: '__statusview_listener',

  async run({ sock, message }) {
    try {
      if (!sock || !message?.key) return
      if (message.key.fromMe) return

      const jid = message.key.remoteJid

      // Only process WhatsApp Status updates.
      if (jid !== 'status@broadcast') return

      const settings = await loadSettings()
      if (!settings.enabled) return

      if (!message.key.id) return

      if (typeof sock.readMessages !== 'function') {
        console.warn(
          '[STATUS VIEW] sock.readMessages is unavailable'
        )
        return
      }

      // Mark this specific status message as read.
      await sock.readMessages([message.key])

      console.log('[STATUS VIEW] Status viewed successfully')
    } catch (error) {
      console.error(
        '[STATUS VIEW] Failed:',
        error?.message || error
      )
    }
  }
}

/**
 * Commands:
 * .statusview on
 * .statusview off
 * .statusview status
 */
const statusViewCommand = {
  command: 'statusview',
  category: 'tools',
  description: 'Automatically view WhatsApp Status updates',

  async run({ sock, message, args = [], isOwner }) {
    const jid = message?.key?.remoteJid
    if (!jid) return

    const reply = async (text) => {
      await sock.sendMessage(
        jid,
        { text },
        { quoted: message }
      )
    }

    if (!isOwner) {
      return reply('❌ ONLY THE BOT OWNER CAN CHANGE STATUS VIEW SETTINGS')
    }

    const settings = await loadSettings()
    const action = String(args[0] || 'status').toLowerCase()

    switch (action) {
      case 'on':
      case 'enable':
      case 'start': {
        settings.enabled = true
        await saveSettings(settings)

        return reply(
          '✅ AUTO STATUS VIEW ENABLED\n\nINCOMING STATUS UPDATES WILL BE MARKED AS VIEWED'
        )
      }

      case 'off':
      case 'disable':
      case 'stop': {
        settings.enabled = false
        await saveSettings(settings)

        return reply('❌ AUTO STATUS VIEW DISABLED')
      }

      case 'status': {
        return reply(
          [
            '╭━━━〔 AUTO STATUS VIEW 〕',
            '│',
            `│ STATUS ${settings.enabled ? 'ON ✅' : 'OFF ❌'}`,
            '│',
            `│ COMMANDS`,
            `│ ${getPrefix()}statusview on`,
            `│ ${getPrefix()}statusview off`,
            `│ ${getPrefix()}statusview status`,
            '│',
            '╰━━━━━━━━━━━━━━━━━━'
          ].join('\n')
        )
      }

      default: {
        return reply(
          [
            '❓ INVALID OPTION',
            '',
            `${getPrefix()}statusview on`,
            `${getPrefix()}statusview off`,
            `${getPrefix()}statusview status`
          ].join('\n')
        )
      }
    }
  }
}

export default statusViewCommand
