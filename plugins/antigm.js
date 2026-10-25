import { getDb, saveDb } from '../database/index.js'

const SETTINGS_FILE = 'antigm-settings.json'
const DEFAULT_SETTINGS = { enabled: true }

async function loadSettings() {
  try {
    const saved = await getDb(SETTINGS_FILE, {})
    return { ...DEFAULT_SETTINGS, ...(saved && typeof saved === 'object' ? saved : {}) }
  } catch (e) {
    console.error('[ANTIGM] Settings load failed:', e?.message || e)
    return { ...DEFAULT_SETTINGS }
  }
}

async function saveSettings(s) {
  try {
    await saveDb(SETTINGS_FILE, s)
  } catch (e) {
    console.error('[ANTIGM] Settings save failed:', e?.message || e)
  }
}

/*
 * Unwrap ephemeral / view-once / document-with-caption wrappers so we
 * can inspect the real inner message content.
 */
function unwrap(m) {
  let cur = m
  for (let i = 0; i < 8; i++) {
    const next =
      cur?.ephemeralMessage?.message ||
      cur?.viewOnceMessage?.message ||
      cur?.viewOnceMessageV2?.message ||
      cur?.viewOnceMessageV2Extension?.message ||
      cur?.documentWithCaptionMessage?.message
    if (!next || typeof next !== 'object') break
    cur = next
  }
  return cur
}

function getMessageContent(message) {
  const m = unwrap(message?.message)
  if (!m) return { type: null, inner: null, text: '' }
  const type = Object.keys(m)[0]
  const inner = type ? m[type] : null
  const text =
    inner?.text ||
    inner?.caption ||
    (typeof m.conversation === 'string' ? m.conversation : '') ||
    ''
  return { type, inner, text }
}

/*
 * Detect whether a message is a personal-status mention/reply.
 *
 * Methods (any one being true → it's a status mention):
 *   1. contextInfo.remoteJid === 'status@broadcast'
 *      — classic status-reply: this is the standard indicator WhatsApp
 *        attaches when someone responds to a status.
 *   2. contextInfo.statusAttributions is a non-empty array
 *      — newer WhatsApp format for status attribution.
 *   3. Text / caption contains a wa.me/status/ or
 *      chat.whatsapp.com/status/ link.
 *   4. The quoted message inside contextInfo is a status reply.
 */
function isStatusMention(message) {
  const { inner, text } = getMessageContent(message)
  if (!inner && !text) return false

  const ctx = inner?.contextInfo || {}

  if (ctx.remoteJid === 'status@broadcast') return true

  if (Array.isArray(ctx.statusAttributions) && ctx.statusAttributions.length > 0) {
    return true
  }

  if (text && /(wa\.me\/status\/|chat\.whatsapp\.com\/status\/)/i.test(text)) {
    return true
  }

  const q = ctx.quotedMessage
  if (q) {
    const qType = Object.keys(q)[0]
    const qInner = qType ? q[qType] : null
    if (qInner?.contextInfo?.remoteJid === 'status@broadcast') return true
  }

  return false
}

async function isBotAdmin(sock, groupJid) {
  try {
    const metadata = await sock.groupMetadata(groupJid)
    const botId = String(sock.user?.id || '')
      .split(':')[0]
      .split('@')[0]
    if (!botId) return false
    return (metadata.participants || []).some(p => {
      const pId = String(p.id || '').split(':')[0].split('@')[0]
      return (
        pId === botId &&
        (p.admin === 'admin' || p.admin === 'superadmin')
      )
    })
  } catch {
    return false
  }
}

/*
 * ==============================
 * LISTENER
 * ==============================
 */

export const antigmListener = {
  command: '__antigm_listener',
  category: 'group',

  async run({ sock, message }) {
    try {
      if (!sock || !message?.key) return
      if (message.key.fromMe) return

      const jid = String(message.key.remoteJid || '')
      if (!jid.endsWith('@g.us')) return

      // Skip group-status posts — those are meant for the group.
      if (message.message?.groupStatusMessageV2) return

      const settings = await loadSettings()
      if (!settings.enabled) return

      if (!isStatusMention(message)) return

      // Bot must be admin to delete someone else's message.
      const botIsAdmin = await isBotAdmin(sock, jid)
      if (!botIsAdmin) {
        console.warn(
          `[ANTIGM] Bot is not admin in ${jid} — cannot delete status mention`
        )
        return
      }

      // Small delay — WhatsApp sometimes rejects delete on very fresh messages.
      await new Promise(r => setTimeout(r, 300))

      await sock.sendMessage(jid, { delete: message.key })

      const sender = String(message.key.participant || '')
        .split('@')[0]
        .split(':')[0]
      console.log(
        `[ANTIGM] ✓ Deleted status mention from ${sender} in ${jid}`
      )
    } catch (e) {
      console.error('[ANTIGM] Listener failed:', e?.message || e)
    }
  }
}

/*
 * ==============================
 * COMMAND
 * ==============================
 */

const antigmCommand = {
  command: 'antigm',
  category: 'group',
  description: 'Delete personal status mentions in groups',

  async run({ sock, message, args = [], isOwner }) {
    try {
      const jid = message?.key?.remoteJid
      if (!jid) return

      const reply = text =>
        sock.sendMessage(jid, { text }, { quoted: message }).catch(() => {})

      if (!isOwner) {
        return reply('❌ ᴏɴʟʏ ᴛʜᴇ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴄʜᴀɴɢᴇ ᴀɴᴛɪ-ɢᴍ ꜱᴇᴛᴛɪɴɢꜱ')
      }

      const settings = await loadSettings()
      const action = String(args[0] || 'status').toLowerCase()

      switch (action) {
        case 'on':
        case 'enable':
          settings.enabled = true
          await saveSettings(settings)
          return reply(
            '✅ ᴀɴᴛɪ-ɢᴍ ᴇɴᴀʙʟᴇᴅ\n\nꜱᴛᴀᴛᴜꜱ ᴍᴇɴᴛɪᴏɴꜱ ɪɴ ɢʀᴏᴜᴘꜱ ᴡɪʟʟ ʙᴇ ᴅᴇʟᴇᴛᴇᴅ'
          )

        case 'off':
        case 'disable':
          settings.enabled = false
          await saveSettings(settings)
          return reply('❌ ᴀɴᴛɪ-ɢᴍ ᴅɪꜱᴀʙʟᴇᴅ')

        case 'status':
        default:
          return reply(
            [
              '╭━━━〔 ᴀɴᴛɪ-ɢᴍ 〕',
              '│',
              `│ ꜱᴛᴀᴛᴜꜱ: ${settings.enabled ? 'ON ✅' : 'OFF ❌'}`,
              '│',
              '│ ᴄᴏᴍᴍᴀɴᴅꜱ',
              '│ .antigm on',
              '│ .antigm off',
              '│ .antigm status',
              '│',
              '╰━━━━━━━━━━━━━━━━━━'
            ].join('\n')
          )
      }
    } catch (e) {
      console.error('[ANTIGM] Command failed:', e?.message || e)
    }
  }
}

export default antigmCommand
