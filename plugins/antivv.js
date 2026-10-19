import { getDb, saveDb } from '../database/index.js'

const SETTINGS_FILE = 'autovv-settings.json'
const DEFAULT_SETTINGS = { enabled: true, targetJid: '' }

async function loadSettings() {
  try {
    const saved = await getDb(SETTINGS_FILE, {})
    return { ...DEFAULT_SETTINGS, ...(saved && typeof saved === 'object' ? saved : {}) }
  } catch (e) {
    console.error('[AUTOVV] Settings load failed:', e?.message || e)
    return { ...DEFAULT_SETTINGS }
  }
}

async function saveSettings(s) {
  try {
    await saveDb(SETTINGS_FILE, s)
  } catch (e) {
    console.error('[AUTOVV] Settings save failed:', e?.message || e)
  }
}

function resolveTarget(settings, sock) {
  if (settings.targetJid) return settings.targetJid
  if (!sock?.user?.id) return null
  return sock.user.id.split(':')[0] + '@s.whatsapp.net'
}

function unwrapViewOnce(message) {
  if (!message?.message) return null
  return (
    message.message.viewOnceMessage?.message ||
    message.message.viewOnceMessageV2?.message ||
    message.message.viewOnceMessageV2Extension?.message ||
    null
  )
}

function getSenderLabel(message) {
  const sender = message.key.participant || message.key.remoteJid
  return String(sender).split('@')[0].split(':')[0]
}

async function forwardViewOnce(sock, targetJid, message) {
  const inner = unwrapViewOnce(message)
  if (!inner) return

  const type = Object.keys(inner)[0]
  const senderNum = getSenderLabel(message)
  const isGroup = String(message.key.remoteJid).endsWith('@g.us')
  const groupNum = isGroup ? String(message.key.remoteJid).split('@')[0] : null

  const caption = [
    '👁️ ᴀᴜᴛᴏ ᴠɪᴇᴡ-ᴏɴᴄᴇ ʀᴇᴠᴇᴀʟ',
    '',
    `ꜱᴇɴᴅᴇʀ : ${senderNum}`,
    groupNum ? `ɢʀᴏᴜᴘ  : ${groupNum}` : null
  ].filter(Boolean).join('\n')

  const media = await sock.downloadMediaMessage({
    message: inner,
    key: message.key
  })

  const opts = { caption }
  if (type === 'imageMessage') opts.image = media
  else if (type === 'videoMessage') opts.video = media
  else if (type === 'audioMessage') { opts.audio = media; delete opts.caption }
  else if (type === 'stickerMessage') { opts.sticker = media; delete opts.caption }
  else if (type === 'documentMessage') {
    opts.document = media
    opts.mimetype = inner.documentMessage.mimetype
    opts.fileName = inner.documentMessage.fileName
  } else {
    await sock.sendMessage(targetJid, { text: `${caption}\n\n[Unsupported: ${type}]` })
    return
  }

  await sock.sendMessage(targetJid, opts)
}

export const autovvListener = {
  command: '__autovv_listener',
  category: 'tools',

  async run({ sock, message }) {
    try {
      if (!sock || !message?.key) return
      if (message.key.fromMe) return
      if (message.key.remoteJid === 'status@broadcast') return

      const inner = unwrapViewOnce(message)
      if (!inner) return

      const settings = await loadSettings()
      if (!settings.enabled) return

      const targetJid = resolveTarget(settings, sock)
      if (!targetJid) return

      await forwardViewOnce(sock, targetJid, message)
      console.log(`[AUTOVV] Forwarded view-once from ${getSenderLabel(message)}`)

      // Mark as read AFTER forwarding — the receipt invalidates the media key
      try { await sock.readMessages([message.key]) } catch {}
    } catch (e) {
      console.error('[AUTOVV] Listener failed:', e?.message || e)
    }
  }
}

const autovvCommand = {
  command: 'autovv',
  category: 'tools',
  description: 'Forward view-once messages to the owner',

  async run({ sock, message, args = [], isOwner }) {
    try {
      const jid = message?.key?.remoteJid
      if (!jid) return

      const reply = text =>
        sock.sendMessage(jid, { text }, { quoted: message }).catch(() => {})

      if (!isOwner) {
        return reply('❌ ᴏɴʟʏ ᴛʜᴇ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴄʜᴀɴɢᴇ ᴀᴜᴛᴏ-ᴠᴠ ꜱᴇᴛᴛɪɴɢꜱ')
      }

      const settings = await loadSettings()
      const action = String(args[0] || 'status').toLowerCase()

      switch (action) {
        case 'on':
        case 'enable':
          settings.enabled = true
          await saveSettings(settings)
          return reply('✅ ᴀᴜᴛᴏ ᴠɪᴇᴡ-ᴏɴᴄᴇ ʀᴇᴠᴇᴀʟ ᴇɴᴀʙʟᴇᴅ')

        case 'off':
        case 'disable':
          settings.enabled = false
          await saveSettings(settings)
          return reply('❌ ᴀᴜᴛᴏ ᴠɪᴇᴡ-ᴏɴᴄᴇ ʀᴇᴠᴇᴀʟ ᴅɪꜱᴀʙʟᴇᴅ')

        case 'set': {
          const raw = String(args[1] || '').trim()
          if (!raw) return reply('ᴜꜱᴀɢᴇ: .autovv set <number|jid>')
          const targetJid = raw.includes('@')
            ? raw
            : raw.replace(/\D/g, '') + '@s.whatsapp.net'
          if (!/^[\w.-]+@(s\.whatsapp\.net|g\.us)$/i.test(targetJid)) {
            return reply('❌ ɪɴᴠᴀʟɪᴅ ᴊɪᴅ')
          }
          settings.targetJid = targetJid
          await saveSettings(settings)
          return reply(`✅ ᴀᴜᴛᴏ-ᴠᴠ ᴛᴀʀɢᴇᴛ ꜱᴇᴛ ᴛᴏ\n${targetJid}`)
        }

        case 'reset':
          settings.targetJid = ''
          await saveSettings(settings)
          return reply('✅ ᴀᴜᴛᴏ-ᴠᴠ ᴛᴀʀɢᴇᴛ ʀᴇꜱᴇᴛ ᴛᴏ ʙᴏᴛ ᴊɪᴅ')

        case 'status':
        default: {
          const target = resolveTarget(settings, sock)
          return reply([
            '╭━━━〔 ᴀᴜᴛᴏ ᴠɪᴇᴡ-ᴏɴᴄᴇ 〕',
            '│',
            `│ ꜱᴛᴀᴛᴜꜱ : ${settings.enabled ? 'ᴏɴ ✅' : 'ᴏғғ ❌'}`,
            `│ ᴛᴀʀɢᴇᴛ : ${settings.targetJid || '(bot jid)'}`,
            `│ ʀᴇꜱᴏʟᴠᴇᴅ : ${target || '—'}`,
            '│',
            '│ ᴄᴏᴍᴍᴀɴᴅꜱ',
            '│ .autovv on',
            '│ .autovv off',
            '│ .autovv set <number|jid>',
            '│ .autovv reset',
            '│ .autovv status',
            '│',
            '╰━━━━━━━━━━━━━━━━━━'
          ].join('\n'))
        }
      }
    } catch (e) {
      console.error('[AUTOVV] Command failed:', e?.message || e)
    }
  }
}

export default autovvCommand
