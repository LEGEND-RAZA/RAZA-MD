import { getDb, saveDb } from '../database/index.js'

const SETTINGS_FILE = 'status-view-settings.json'

const DEFAULT_SETTINGS = {
  enabled: true
}

/*
 * ==============================
 * SETTINGS
 * ==============================
 */

async function loadSettings() {
  try {
    const saved = await getDb(SETTINGS_FILE, {})
    return {
      ...DEFAULT_SETTINGS,
      ...(saved && typeof saved === 'object' ? saved : {})
    }
  } catch (error) {
    console.error('[STATUS VIEW] Settings load failed:', error?.message || error)
    return { ...DEFAULT_SETTINGS }
  }
}

async function saveSettings(settings) {
  try {
    await saveDb(SETTINGS_FILE, settings)
  } catch (error) {
    console.error('[STATUS VIEW] Settings save failed:', error?.message || error)
  }
}

function getPrefix() {
  return process.env.PREFIX || '.'
}

/*
 * ==============================
 * AUTO-VIEW LISTENER
 * ==============================
 *
 * Called by handler.js for every incoming message (listeners run
 * before any prefix / owner / status filtering). We self-filter
 * here so only status@broadcast messages are acted on.
 */

export const statusViewListener = {
  command: '__statusview_listener',
  category: 'tools',

  async run({ sock, message, isStatus }) {
    try {
      if (!sock || !message?.key) return
      if (message.key.fromMe) return

      const jid = message.key.remoteJid

      // Only process WhatsApp Status updates.
      // Trust the handler flag if present, otherwise check the jid.
      const isBroadcast =
        isStatus === true || jid === 'status@broadcast'

      if (!isBroadcast) return
      if (!message.key.id) return

      const settings = await loadSettings()
      if (!settings.enabled) return

      // The poster's JID lives on key.participant (Baileys ≥6.x) or
      // message.participant (older / some builds). We need it to
      // address the receipt correctly — without it, WhatsApp drops it.
      const participant =
        message.key.participant ||
        message.participant ||
        message.key.participantAlt ||
        message.key.remoteJidAlt

      if (
        !participant ||
        participant === 'status@broadcast' ||
        !String(participant).includes('@')
      ) {
        console.warn('[STATUS VIEW] Missing participant, skipping status')
        return
      }

      // Build a clean key — never reuse message.key directly. Extra
      // fields like isViewOnce, server_id, or fromMe:true cause the
      // receipt to be silently ignored by WhatsApp.
      const statusKey = {
        remoteJid: 'status@broadcast',
        id: message.key.id,
        participant,
        fromMe: false
      }

      // Primary path: sock.readMessages (present on most Baileys builds).
      if (typeof sock.readMessages === 'function') {
        await sock.readMessages([statusKey])
      }
      // Fallback: raw receipt — works even if readMessages was removed.
      else if (typeof sock.sendReceipt === 'function') {
        await sock.sendReceipt(
          'status@broadcast',
          participant,
          [message.key.id],
          'read'
        )
      } else {
        console.warn('[STATUS VIEW] Socket has no readMessages/sendReceipt')
        return
      }

      console.log(
        `[STATUS VIEW] Viewed status from ${String(participant).slice(0, 8)}…`
      )
    } catch (error) {
      console.error(
        '[STATUS VIEW] Listener failed:',
        error?.stack || error?.message || error
      )
    }
  }
}

/*
 * ==============================
 * COMMAND
 * ==============================
 *
 * Commands:
 *   .statusview on
 *   .statusview off
 *   .statusview status
 */

const statusViewCommand = {
  command: 'statusview',
  category: 'tools',
  description: 'Automatically view WhatsApp Status updates',

  async run({ sock, message, args = [], isOwner }) {
    try {
      const jid = message?.key?.remoteJid
      if (!jid) return

      const reply = text =>
        sock
          .sendMessage(jid, { text }, { quoted: message })
          .catch(() => {})

      if (!isOwner) {
        return reply(
          '❌ ONLY THE BOT OWNER CAN CHANGE STATUS VIEW SETTINGS'
        )
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
              '│ COMMANDS',
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
    } catch (error) {
      console.error(
        '[STATUS VIEW] Command error:',
        error?.stack || error?.message || error
      )
    }
  }
}

export default statusViewCommand
