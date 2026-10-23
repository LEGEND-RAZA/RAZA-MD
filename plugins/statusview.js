import { getDb, saveDb } from '../database/index.js'

const SETTINGS_FILE = 'status-view-settings.json'
const DEFAULT_SETTINGS = { enabled: false }

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

      const candidates = [
        message.key.participant,
        message.key.participantAlt,
        message.key.remoteJidAlt,
        message.participant,
        message.participantAlt
      ].filter(Boolean)

      const participant = candidates.find(p =>
        String(p).includes('@') && p !== 'status@broadcast'
      )

      if (!participant) {
        console.warn('[STATUS VIEW] No valid participant JID')
        return
      }

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

      if (typeof sock.readMessages === 'function') {
        await sock.readMessages([
          {
            remoteJid: 'status@broadcast',
            id: message.key.id,
            participant,
            fromMe: false
          }
        ])
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
 * COMMAND (small-caps styled)
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
          '❌ ᴏɴʟʏ ᴛʜᴇ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴄʜᴀɴɢᴇ ꜱᴛᴀᴛᴜꜱ ᴠɪᴇᴡ ꜱᴇᴛᴛɪɴɢꜱ'
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
            [
              '✅ ᴀᴜᴛᴏ ꜱᴛᴀᴛᴜꜱ ᴠɪᴇᴡ ᴇɴᴀʙʟᴇᴅ',
              '',
              'ɪɴᴄᴏᴍɪɴɢ ꜱᴛᴀᴛᴜꜱ ᴜᴘᴅᴀᴛᴇꜱ ᴡɪʟʟ ʙᴇ ᴍᴀʀᴋᴇᴅ ᴀꜱ ᴠɪᴇᴡᴇᴅ'
            ].join('\n')
          )
        }

        case 'off':
        case 'disable':
        case 'stop': {
          settings.enabled = false
          await saveSettings(settings)

          return reply('❌ ᴀᴜᴛᴏ ꜱᴛᴀᴛᴜꜱ ᴠɪᴇᴡ ᴅɪꜱᴀʙʟᴇᴅ')
        }

        case 'status': {
          return reply(
            [
              '╭━━━〔 ᴀᴜᴛᴏ ꜱᴛᴀᴛᴜꜱ ᴠɪᴇᴡ 〕',
              '│',
              `│ ꜱᴛᴀᴛᴜꜱ : ${settings.enabled ? 'ᴏɴ ✅' : 'ᴏғғ ❌'}`,
              '│',
              '│ ᴄᴏᴍᴍᴀɴᴅꜱ',
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
              '❓ ɪɴᴠᴀʟɪᴅ ᴏᴘᴛɪᴏɴ',
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
