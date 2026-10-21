import { getDb, saveDb } from '../database/index.js'
import pino from 'pino'

const SETTINGS_FILE = 'antivv-settings.json'
const DEFAULT_SETTINGS = { enabled: true, targetJid: '' }

// WhatsApp per-message media cap (images, video, audio). Documents allow more,
// but for simplicity we use one consistent limit for all forwarded media.
const MAX_MEDIA_BYTES = 16 * 1024 * 1024

const logger = pino({ level: 'silent' })

// LID → PN mapping (same approach as antidelete)
const lidToPn = new Map()
const pnToLid = new Map()

async function loadSettings() {
  try {
    const saved = await getDb(SETTINGS_FILE, {})
    return { ...DEFAULT_SETTINGS, ...(saved && typeof saved === 'object' ? saved : {}) }
  } catch (e) {
    console.error('[ANTIVV] Settings load failed:', e?.message || e)
    return { ...DEFAULT_SETTINGS }
  }
}

async function saveSettings(s) {
  try {
    await saveDb(SETTINGS_FILE, s)
  } catch (e) {
    console.error('[ANTIVV] Settings save failed:', e?.message || e)
  }
}

function resolveTarget(settings, sock) {
  if (settings.targetJid) return settings.targetJid
  if (!sock?.user?.id) return null
  return sock.user.id.split(':')[0] + '@s.whatsapp.net'
}

/*
 * ==============================
 * LID ↔ PN MAPPING
 * ==============================
 */

function rememberPair(primary, alternate) {
  if (!primary || !alternate) return
  const p = String(primary)
  const a = String(alternate)
  if (p === a || !p.includes('@') || !a.includes('@')) return

  const pLid = p.endsWith('@lid')
  const aLid = a.endsWith('@lid')
  if (pLid === aLid) return

  if (pLid && !aLid) {
    lidToPn.set(p, a)
    pnToLid.set(a, p)
  } else {
    lidToPn.set(a, p)
    pnToLid.set(p, a)
  }
}

function rememberMessageIdentities(message) {
  const k = message?.key || {}
  rememberPair(k.participant, k.participantAlt)
  rememberPair(k.remoteJid, k.remoteJidAlt)
  if (message?.participant || message?.participantAlt) {
    rememberPair(message.participant, message.participantAlt)
  }
}

function resolveSenderJid(message) {
  const k = message?.key || {}
  const m = message || {}
  const candidates = [
    k.participant,
    k.participantAlt,
    k.remoteJidAlt,
    m.participant,
    m.participantAlt
  ].filter(Boolean).map(String)

  for (const c of candidates) {
    if (c.endsWith('@s.whatsapp.net')) return c
  }
  for (const c of candidates) {
    if (c.endsWith('@lid')) {
      const pn = lidToPn.get(c)
      if (pn) return pn
    }
  }
  for (const c of candidates) {
    if (!c.endsWith('@lid')) return c
  }
  return candidates[0] || ''
}

function displayNum(jid, fallback = 'unknown') {
  if (!jid) return fallback
  const s = String(jid)
  const num = s.split('@')[0].split(':')[0]
  if (!num) return fallback
  if (s.endsWith('@lid') && !lidToPn.has(s)) return `${num} (LID)`
  return num
}

/*
 * ==============================
 * VIEW-ONCE UNWRAP
 * ==============================
 */

function unwrapViewOnce(message) {
  if (!message?.message) return null

  let m = message.message

  if (m.groupStatusMessageV2?.message) m = m.groupStatusMessageV2.message
  if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message

  return (
    m.viewOnceMessage?.message ||
    m.viewOnceMessageV2?.message ||
    m.viewOnceMessageV2Extension?.message ||
    null
  )
}

/*
 * ==============================
 * DOWNLOAD
 * ==============================
 */

async function downloadOnce(sock, message, inner) {
  const ctx = {
    logger,
    reconnectAttempts: 5,
    timeoutMs: 180000
  }
  if (typeof sock.updateMediaMessage === 'function') {
    ctx.reuploadRequest = msg => sock.updateMediaMessage(msg)
  }

  return sock.downloadMediaMessage(
    { message: inner, key: message.key },
    'buffer',
    {},
    ctx
  )
}

async function downloadViewOnce(sock, message, inner) {
  let lastErr
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const buffer = await downloadOnce(sock, message, inner)
      if (!Buffer.isBuffer(buffer) || !buffer.length) {
        throw new Error('Empty media buffer')
      }
      return buffer
    } catch (e) {
      lastErr = e
      console.error(
        `[ANTIVV] download attempt ${attempt} failed:`,
        e?.message || e
      )
      if (attempt < 2) await new Promise(r => setTimeout(r, 2000))
    }
  }
  throw lastErr
}

/*
 * ==============================
 * FORWARD
 * ==============================
 */

async function forwardViewOnce(sock, targetJid, message, inner) {
  const type = Object.keys(inner)[0]

  const senderJid = resolveSenderJid(message)
  const senderNum = displayNum(senderJid)

  const isGroup = String(message.key.remoteJid || '').endsWith('@g.us')
  const groupJid = isGroup ? String(message.key.remoteJid) : null

  const caption = [
    '👁️ ᴀᴜᴛᴏ ᴠɪᴇᴡ-ᴏɴᴄᴇ ʀᴇᴠᴇᴀʟ',
    '',
    `ꜱᴇɴᴅᴇʀ : ${senderNum}`,
    groupJid ? `ɢʀᴏᴜᴘ  : ${groupJid}` : null
  ].filter(Boolean).join('\n')

  const media = await downloadViewOnce(sock, message, inner)

  if (media.length > MAX_MEDIA_BYTES) {
    await sock.sendMessage(targetJid, {
      text:
        `${caption}\n\n` +
        `[Media too large: ${(media.length / 1024 / 1024).toFixed(1)} MB ` +
        `— WA limit is ${MAX_MEDIA_BYTES / 1024 / 1024} MB]`
    })
    return type
  }

  const opts = {}

  if (type === 'imageMessage') {
    opts.image = media
    opts.caption = caption
  } else if (type === 'videoMessage') {
    opts.video = media
    opts.caption = caption
  } else if (type === 'audioMessage') {
    opts.audio = media
    opts.mimetype =
      inner.audioMessage?.mimetype || 'audio/ogg; codecs=opus'
    opts.ptt = inner.audioMessage?.ptt === true
  } else if (type === 'stickerMessage') {
    opts.sticker = media
  } else if (type === 'documentMessage') {
    opts.document = media
    opts.mimetype =
      inner.documentMessage?.mimetype || 'application/octet-stream'
    opts.fileName =
      inner.documentMessage?.fileName || 'document'
    opts.caption = caption
  } else {
    await sock.sendMessage(targetJid, {
      text: `${caption}\n\n[Unsupported: ${type}]`
    })
    return type
  }

  await sock.sendMessage(targetJid, opts)
  return type
}

/*
 * ==============================
 * LISTENER
 * ==============================
 */

export const antivvListener = {
  command: '__antivv_listener',
  category: 'tools',

  async run({ sock, message }) {
    try {
      if (!sock || !message?.key) return
      if (message.key.remoteJid === 'status@broadcast') return

      // Build the LID↔PN map from EVERY incoming message, even non-VV.
      rememberMessageIdentities(message)

      // Skip own messages — the user already has them, no need to forward.
      if (message.key.fromMe) return

      const inner = unwrapViewOnce(message)
      if (!inner) return

      const settings = await loadSettings()
      if (!settings.enabled) return

      const targetJid = resolveTarget(settings, sock)
      if (!targetJid) return

      const type = await forwardViewOnce(sock, targetJid, message, inner)
      const senderNum = displayNum(resolveSenderJid(message))
      const isGroup = String(message.key.remoteJid || '').endsWith('@g.us')

      console.log(
        `[ANTIVV] ✓ forwarded ${type} from ${senderNum}` +
        (isGroup ? ` in ${message.key.remoteJid}` : '')
      )

      // Mark as read only AFTER successful forward — the read receipt
      // invalidates the media key, so we must download + forward first.
      try {
        await sock.readMessages([message.key])
      } catch (e) {
        console.error('[ANTIVV] readMessages failed:', e?.message || e)
      }
    } catch (e) {
      console.error('[ANTIVV] Listener failed:', e?.message || e)
    }
  }
}

/*
 * ==============================
 * COMMAND
 * ==============================
 */

const antivvCommand = {
  command: 'antivv',
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
          if (!raw) return reply('ᴜꜱᴀɢᴇ: .antivv set <number|jid>')
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
            `│ ʟɪᴅ → ᴘɴ : ${lidToPn.size} ᴍᴀᴘᴘɪɴɢꜱ`,
            `│ ᴍᴀx ᴍᴇᴅɪᴀ : ${MAX_MEDIA_BYTES / 1024 / 1024} ᴍʙ`,
            '│',
            '│ ᴄᴏᴍᴍᴀɴᴅꜱ',
            '│ .antivv on',
            '│ .antivv off',
            '│ .antivv set <number|jid>',
            '│ .antivv reset',
            '│ .antivv status',
            '│',
            '╰━━━━━━━━━━━━━━━━━━'
          ].join('\n'))
        }
      }
    } catch (e) {
      console.error('[ANTIVV] Command failed:', e?.message || e)
    }
  }
}

export default antivvCommand
