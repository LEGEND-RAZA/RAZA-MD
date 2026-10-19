import { getDb, saveDb } from '../database/index.js'

const SETTINGS_FILE = 'antidelete-settings.json'
const DEFAULT_SETTINGS = { enabled: true, targetJid: '' }

const MAX_CACHE = 2000
const CACHE_TTL_MS = 30 * 60 * 1000
const messageCache = new Map()
let pruneIntervalStarted = false
let updateHandlerRegistered = false

async function loadSettings() {
  try {
    const saved = await getDb(SETTINGS_FILE, {})
    return { ...DEFAULT_SETTINGS, ...(saved && typeof saved === 'object' ? saved : {}) }
  } catch (e) {
    console.error('[ANTIDELETE] Settings load failed:', e?.message || e)
    return { ...DEFAULT_SETTINGS }
  }
}

async function saveSettings(s) {
  try {
    await saveDb(SETTINGS_FILE, s)
  } catch (e) {
    console.error('[ANTIDELETE] Settings save failed:', e?.message || e)
  }
}

function resolveTarget(settings, sock) {
  if (settings.targetJid) return settings.targetJid
  if (!sock?.user?.id) return null
  return sock.user.id.split(':')[0] + '@s.whatsapp.net'
}

function cacheKeyOf(key) {
  if (!key?.id || !key?.remoteJid) return null
  return `${key.remoteJid}:${key.id}`
}

function cacheMessage(message) {
  if (!message?.key?.id || !message?.key?.remoteJid) return
  if (message.key.fromMe) return
  if (message.key.remoteJid === 'status@broadcast') return

  const cacheKey = cacheKeyOf(message.key)
  if (!cacheKey) return

  messageCache.set(cacheKey, { message, ts: Date.now() })

  if (messageCache.size > MAX_CACHE) {
    const sorted = [...messageCache.entries()].sort((a, b) => a[1].ts - b[1].ts)
    const excess = messageCache.size - MAX_CACHE
    for (let i = 0; i < excess; i++) messageCache.delete(sorted[i][0])
  }
}

function getCached(key) {
  const cacheKey = cacheKeyOf(key)
  if (!cacheKey) return null
  const entry = messageCache.get(cacheKey)
  if (!entry) return null
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    messageCache.delete(cacheKey)
    return null
  }
  return entry.message
}

function pruneCache() {
  const now = Date.now()
  let removed = 0
  for (const [k, v] of messageCache) {
    if (now - v.ts > CACHE_TTL_MS) {
      messageCache.delete(k)
      removed++
    }
  }
  if (removed) console.log(`[ANTIDELETE] Pruned ${removed} cache entries (${messageCache.size} remain)`)
}

async function forwardToTarget(sock, targetJid, original, revokerJid) {
  const sender = original.key.participant || original.key.remoteJid
  const senderNum = String(sender).split('@')[0].split(':')[0]
  const revokerNum = String(revokerJid || sender).split('@')[0].split(':')[0]
  const isGroup = String(original.key.remoteJid).endsWith('@g.us')
  const groupNum = isGroup ? String(original.key.remoteJid).split('@')[0] : null

  const header = [
    '🗑️ ᴀɴᴛɪ-ᴅᴇʟᴇᴛᴇ',
    '',
    `ꜱᴇɴᴅᴇʀ : ${senderNum}`,
    groupNum ? `ɢʀᴏᴜᴘ  : ${groupNum}` : null,
    `ᴅᴇʟᴇᴛᴇᴅ ʙʏ : ${revokerNum}`
  ].filter(Boolean).join('\n')

  const inner = original.message || {}
  const type = Object.keys(inner)[0]

  try {
    if (type === 'conversation' || type === 'extendedTextMessage') {
      const text = inner.conversation || inner.extendedTextMessage?.text || ''
      await sock.sendMessage(targetJid, { text: `${header}\n\n${text}` })
      return
    }

    const media = await sock.downloadMediaMessage(original)
    const sendOpts = {}
    if (type === 'imageMessage') sendOpts.image = media
    else if (type === 'videoMessage') sendOpts.video = media
    else if (type === 'audioMessage') sendOpts.audio = media
    else if (type === 'stickerMessage') sendOpts.sticker = media
    else if (type === 'documentMessage') {
      sendOpts.document = media
      sendOpts.mimetype = inner.documentMessage.mimetype
      sendOpts.fileName = inner.documentMessage.fileName
    } else {
      await sock.sendMessage(targetJid, { text: `${header}\n\n[Unsupported: ${type}]` })
      return
    }

    if (type !== 'stickerMessage') sendOpts.caption = header
    await sock.sendMessage(targetJid, sendOpts)
  } catch (e) {
    console.error('[ANTIDELETE] Forward failed:', e?.message || e)
    try {
      await sock.sendMessage(targetJid, {
        text: `${header}\n\n[Could not recover media — download failed]`
      })
    } catch {}
  }
}

async function setup(sock) {
  if (!sock || updateHandlerRegistered) return
  updateHandlerRegistered = true

  sock.ev.on('messages.update', async updates => {
    try {
      const settings = await loadSettings()
      if (!settings.enabled) return

      const targetJid = resolveTarget(settings, sock)
      if (!targetJid) return

      for (const item of updates) {
        const { key, update } = item || {}

        // Revoke = messageStubType 1 (WAMessageStubType.REVOKE)
        const isRevoke = update?.messageStubType === 1
        if (!isRevoke) continue

        const cached = getCached(key)
        if (!cached) continue

        const revoker =
          update?.messageStubParameters?.[0] ||
          key?.participant ||
          key?.remoteJid

        await forwardToTarget(sock, targetJid, cached, revoker)
        console.log(`[ANTIDELETE] Recovered deleted message (${key.id?.slice(0, 8)}…)`)
      }
    } catch (e) {
      console.error('[ANTIDELETE] messages.update handler failed:', e?.message || e)
    }
  })

  if (!pruneIntervalStarted) {
    pruneIntervalStarted = true
    setInterval(pruneCache, 5 * 60 * 1000).unref()
  }
}

export const antideleteListener = {
  command: '__antidelete_listener',
  category: 'tools',
  setup,

  async run({ sock, message }) {
    try {
      if (!sock || !message?.key) return
      if (message.key.fromMe) return
      if (message.key.remoteJid === 'status@broadcast') return

      // Always cache incoming messages
      cacheMessage(message)

      // Also handle inline protocolMessage REVOKE (protocol.type === 0)
      const protocol = message.message?.protocolMessage
      if (!protocol || protocol.type !== 0 || !protocol.key) return

      const settings = await loadSettings()
      if (!settings.enabled) return

      const targetJid = resolveTarget(settings, sock)
      if (!targetJid) return

      const cached = getCached(protocol.key)
      if (!cached) {
        console.log(`[ANTIDELETE] Revoked message not in cache (${protocol.key.id?.slice(0, 8)}…)`)
        return
      }

      const revoker = message.key.participant || message.key.remoteJid
      await forwardToTarget(sock, targetJid, cached, revoker)
      console.log(`[ANTIDELETE] Recovered (protocol) deleted message (${protocol.key.id?.slice(0, 8)}…)`)
    } catch (e) {
      console.error('[ANTIDELETE] Listener failed:', e?.message || e)
    }
  }
}

const antideleteCommand = {
  command: 'antidelete',
  category: 'tools',
  description: 'Forward deleted messages to the owner',

  async run({ sock, message, args = [], isOwner }) {
    try {
      const jid = message?.key?.remoteJid
      if (!jid) return

      const reply = text =>
        sock.sendMessage(jid, { text }, { quoted: message }).catch(() => {})

      if (!isOwner) {
        return reply('❌ ᴏɴʟʏ ᴛʜᴇ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴄʜᴀɴɢᴇ ᴀɴᴛɪ-ᴅᴇʟᴇᴛᴇ ꜱᴇᴛᴛɪɴɢꜱ')
      }

      const settings = await loadSettings()
      const action = String(args[0] || 'status').toLowerCase()

      switch (action) {
        case 'on':
        case 'enable':
          settings.enabled = true
          await saveSettings(settings)
          return reply('✅ ᴀɴᴛɪ-ᴅᴇʟᴇᴛᴇ ᴇɴᴀʙʟᴇᴅ\n\nᴅᴇʟᴇᴛᴇᴅ ᴍᴇꜱꜱᴀɢᴇꜱ ᴡɪʟʟ ʙᴇ ꜰᴏʀᴡᴀʀᴅᴇᴅ ᴛᴏ ʏᴏᴜ')

        case 'off':
        case 'disable':
          settings.enabled = false
          await saveSettings(settings)
          return reply('❌ ᴀɴᴛɪ-ᴅᴇʟᴇᴛᴇ ᴅɪꜱᴀʙʟᴇᴅ')

        case 'set': {
          const raw = String(args[1] || '').trim()
          if (!raw) return reply('ᴜꜱᴀɢᴇ: .antidelete set <number|jid>')
          const targetJid = raw.includes('@')
            ? raw
            : raw.replace(/\D/g, '') + '@s.whatsapp.net'
          if (!/^[\w.-]+@(s\.whatsapp\.net|g\.us)$/i.test(targetJid)) {
            return reply('❌ ɪɴᴠᴀʟɪᴅ ᴊɪᴅ')
          }
          settings.targetJid = targetJid
          await saveSettings(settings)
          return reply(`✅ ᴀɴᴛɪ-ᴅᴇʟᴇᴛᴇ ᴛᴀʀɢᴇᴛ ꜱᴇᴛ ᴛᴏ\n${targetJid}`)
        }

        case 'reset':
          settings.targetJid = ''
          await saveSettings(settings)
          return reply('✅ ᴀɴᴛɪ-ᴅᴇʟᴇᴛᴇ ᴛᴀʀɢᴇᴛ ʀᴇꜱᴇᴛ ᴛᴏ ʙᴏᴛ ᴊɪᴅ')

        case 'status':
        default: {
          const target = resolveTarget(settings, sock)
          return reply([
            '╭━━━〔 ᴀɴᴛɪ-ᴅᴇʟᴇᴛᴇ 〕',
            '│',
            `│ ꜱᴛᴀᴛᴜꜱ : ${settings.enabled ? 'ᴏɴ ✅' : 'ᴏғғ ❌'}`,
            `│ ᴛᴀʀɢᴇᴛ : ${settings.targetJid || '(bot jid)'}`,
            `│ ʀᴇꜱᴏʟᴠᴇᴅ : ${target || '—'}`,
            `│ ᴄᴀᴄʜᴇ : ${messageCache.size} ᴍꜱɢꜱ`,
            '│',
            '│ ᴄᴏᴍᴍᴀɴᴅꜱ',
            '│ .antidelete on',
            '│ .antidelete off',
            '│ .antidelete set <number|jid>',
            '│ .antidelete reset',
            '│ .antidelete status',
            '│',
            '╰━━━━━━━━━━━━━━━━━━'
          ].join('\n'))
        }
      }
    } catch (e) {
      console.error('[ANTIDELETE] Command failed:', e?.message || e)
    }
  }
}

export default antideleteCommand
