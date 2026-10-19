import { getDb, saveDb } from '../database/index.js'

const SETTINGS_FILE = 'status-view-settings.json'
const DEFAULT_SETTINGS = { enabled: true }

async function loadSettings() {
  try {
    const saved = await getDb(SETTINGS_FILE, {})
    return { ...DEFAULT_SETTINGS, ...(saved && typeof saved === 'object' ? saved : {}) }
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
 * AUTO-VIEW LISTENER (Baileys 7.x)
 * ==============================
 *
 * Baileys 7.x uses LID JIDs for Signal sessions. A status message may
 * carry the poster's identity in any of:
 *   key.participant       (@lid OR @s.whatsapp.net)
 *   key.participantAlt    (the matching PN, when participant is a LID)
 *   message.participant   (older builds)
 *   message.participantAlt
 *
 * We try them in order and use whichever looks like a real JID.
 * sendReceipt is the primary path — it is the only reliable way to
 * deliver a status read-receipt on 7.x.
 */

export const statusViewListener = {
  command: '__statusview_listener',
  category: 'tools',

  async run({ sock, message, isStatus }) {
    try {
      if (!sock || !message?.key) return
      if (message.key.fromMe) return

      const jid = message.key.remoteJid
      const isBroadcast = isStatus === true || jid === 'status@broadcast'
      if (!isBroadcast) return
      if (!message.key.id) return

      const settings = await loadSettings()
      if (!settings.enabled) return

      /*
       * Resolve the poster's JID across Baileys 6.x and 7.x shapes.
       */
      const candidates = [
        message.key.participant,
        message.key.participantAlt,
        message.key.remoteJidAlt,
        message.participant,
        message.participantAlt
      ].filter(Boolean)

      const participant = candidates.find(p =>
        String(p).includes('@') &&
        p !== 'status@broadcast'
      )

      if (!participant) {
        console.warn(
          '[STATUS VIEW] No valid participant JID. key:',
          {
            participant: message.key.participant,
            participantAlt: message.key.participantAlt,
            remoteJidAlt: message.key.remoteJidAlt
          }
        )
        return
      }

      /*
       * Primary path: sendReceipt — recommended for status read-receipts
       * on Baileys 7.x. Works whether `participant` is @lid or @s.whatsapp.net.
       */
      if (typeof sock.sendReceipt === 'function') {
        await sock.sendReceipt(
          'status@broadcast',
          participant,
          [message.key.id],
          'read'
        )
        console.log(
          `[STATUS VIEW] Viewed via sendReceipt -> ${String(participant).slice(0, 8)}…`
        )
        return
      }

      /*
       * Fallback path: readMessages (some 7.x RC builds still expose it).
       * Build a clean key — never reuse message.key directly.
       */
      if (typeof sock.readMessages === 'function') {
        const statusKey = {
          remoteJid: 'status@broadcast',
          id: message.key.id,
          participant,
          fromMe: false
        }
        await sock.readMessages([statusKey])
        console.log(
          `[STATUS VIEW] Viewed via readMessages -> ${String(participant).slice(0, 8)}…`
        )
        return
      }

      console.warn('[STATUS VIEW] Socket has neither sendReceipt nor readMessages')
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
