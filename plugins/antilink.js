import { getDb, saveDb } from '../database/index.js'

const DB_KEY = 'antilink.json'

const DEFAULTS = {
  enabled: false,
  limit: 6,
  cooldown: 2 * 60 * 1000, // 2 minutes
  allowed: [],
  mode: 'warn'
}

const linkCount = {}
const lastTime = {}
const warned = {}
const processedMsgs = new Set()

function toSmallCaps(text) {
  const map = {
    a: '\u1D00', b: '\u0299', c: '\u1D04', d: '\u1D05',
    e: '\u1D07', f: '\u0493', g: '\u0262', h: '\u029C',
    i: '\u026A', j: '\u1D0A', k: '\u1D0B', l: '\u029F',
    m: '\u1D0D', n: '\u0274', o: '\u1D0F', p: '\u1D18',
    q: 'q', r: '\u0280', s: 's', t: '\u1D1B',
    u: '\u1D1C', v: '\u1D20', w: '\u1D21', x: 'x',
    y: '\u028F', z: '\u1D22'
  }
  return String(text || '').toLowerCase().split('').map(c => map[c] || c).join('')
}

async function getSettings(jid) {
  try {
    let storage = await getDb(DB_KEY, {})
    if (!storage[jid]) {
      storage[jid] = { ...DEFAULTS }
      try { await saveDb(DB_KEY, storage) } catch (e) { console.error('[ANTILINK SAVE ERROR]', e.message) }
    }
    storage[jid] = {
      ...DEFAULTS,
      ...storage[jid],
      allowed: Array.isArray(storage[jid].allowed) ? storage[jid].allowed : []
    }
    return storage[jid]
  } catch (e) {
    return { ...DEFAULTS }
  }
}

async function saveSettings(jid, newData) {
  try {
    const storage = await getDb(DB_KEY, {})
    const current = storage[jid] || { ...DEFAULTS }
    storage[jid] = { ...current, ...newData }
    await saveDb(DB_KEY, storage)
    return storage[jid]
  } catch (e) {
    console.error('[ANTILINK SETTINGS ERROR]', e.message)
  }
}

function isUrl(text) {
  if (!text) return false
  return text.split(/\s+/).some(word =>
    /(https?:\/\/[^\s]+|chat\.whatsapp\.com\/[^\s]+|wa\.me\/[^\s]+|whatsapp\.com\/channel\/[^\s]+)/i.test(word) &&
    /(chat\.whatsapp\.com|wa\.me|whatsapp\.com\/channel|https?:\/\/)/i.test(word)
  )
}

/* =========================================
   COMMAND HANDLER
========================================= */
export const slinkPlugin = {
  command: ['antilink'],
  category: 'group',

  async run({ sock, message, args, isGroup, isOwner }) {
    const jid = message?.key?.remoteJid
    if (!jid) return

    if (!isGroup) {
      return sock.sendMessage(jid, { text: `❌ ${toSmallCaps('this command can only be used in groups.')}` }, { quoted: message })
    }

    const groupMetadata = await sock.groupMetadata(jid).catch(() => null)
    if (!groupMetadata) return

    const sender = message.key.participant || jid
    const senderBase = sender.split(':')[0]

    const isAdmin = groupMetadata.participants.some(p =>
      p.id?.split(':')[0] === senderBase && Boolean(p.admin)
    )

    if (!isAdmin && !isOwner) {
      return sock.sendMessage(jid, { text: `❌ ${toSmallCaps('only group admins can use this command.')}` }, { quoted: message })
    }

    const cmd = args[0]?.toLowerCase()
    const data = await getSettings(jid)

    if (!cmd) {
      return sock.sendMessage(
        jid,
        {
          text:
            `⚙️ *${toSmallCaps('anti-link settings')}*\n\n` +
            `• *${toSmallCaps('status')}:* ${data.enabled ? 'ON' : 'OFF'}\n` +
            `• *${toSmallCaps('mode')}:* ${toSmallCaps(data.mode)}\n` +
            `• *${toSmallCaps('limit')}:* ${data.limit}\n` +
            `• *${toSmallCaps('cooldown')}:* ${data.cooldown / 1000}s\n` +
            `• *${toSmallCaps('allowed')}:*\n${data.allowed.join('\n') || toSmallCaps('no allowed links')}\n\n` +
            `*${toSmallCaps('modes')}:*\n` +
            `• ${toSmallCaps('.antilink on')} → ${toSmallCaps('warn + kick members')}\n` +
            `• ${toSmallCaps('.antilink all')} → ${toSmallCaps('warn + kick members, delete admin links')}\n` +
            `• ${toSmallCaps('.antilink null')} → ${toSmallCaps('kick members silently (no warning)')}`
        },
        { quoted: message }
      )
    }

    let update = {}
    let successText = ''

    if (cmd === 'on') {
      update = { enabled: true, mode: 'warn' }
      successText = `✅ _${toSmallCaps('anti-link enabled (members only)')}_`
    } else if (cmd === 'all') {
      update = { enabled: true, mode: 'all' }
      successText = `✅ _${toSmallCaps('anti-link enabled (admins + members)')}_`
    } else if (cmd === 'off') {
      update = { enabled: false }
      successText = `❌ _${toSmallCaps('anti-link disabled')}_`
    } else if (cmd === 'null') {
      update = { enabled: true, mode: 'null' }
      successText = `⚙️ _${toSmallCaps('mode set to null (silent kick)')}_`
    } else if (cmd === 'warn') {
      update = { enabled: true, mode: 'warn' }
      successText = `⚙️ _${toSmallCaps('mode set to warn (members only)')}_`
    } else if (cmd === 'cooldown') {
      const num = Number.parseInt(args[1], 10)
      if (!Number.isFinite(num) || num <= 0) {
        return sock.sendMessage(jid, { text: `⚠️ ${toSmallCaps('use: antilink cooldown <seconds>')}` }, { quoted: message })
      }
      update = { cooldown: num * 1000 }
      successText = `⏱️ _${toSmallCaps(`cooldown set to ${num}s`)}_`
    } else if (cmd === 'allow') {
      const link = args.slice(1).join(' ').trim()
      if (!link) {
        return sock.sendMessage(jid, { text: `⚠️ ${toSmallCaps('use: antilink allow <link>')}` }, { quoted: message })
      }
      const allowed = [...(data.allowed || [])]
      if (!allowed.includes(link)) allowed.push(link)
      update = { allowed }
      successText = `✅ _${toSmallCaps('link added to allowed list')}_`
    } else if (cmd === 'remove') {
      const link = args.slice(1).join(' ').trim()
      if (!link) {
        return sock.sendMessage(jid, { text: `⚠️ ${toSmallCaps('use: antilink remove <link>')}` }, { quoted: message })
      }
      update = { allowed: (data.allowed || []).filter(item => item !== link) }
      successText = `✅ _${toSmallCaps('link removed from allowed list')}_`
    } else {
      const num = Number.parseInt(cmd, 10)
      if (!Number.isFinite(num) || num <= 0) {
        return sock.sendMessage(jid, { text: `⚠️ _${toSmallCaps('invalid command')}_` }, { quoted: message })
      }
      update = { limit: num }
      successText = `⚙️ _${toSmallCaps(`limit set to ${num}`)}_`
    }

    await saveSettings(jid, update)
    return sock.sendMessage(jid, { text: successText }, { quoted: message })
  }
}

/* =========================================
   LISTENER HANDLER
========================================= */
export const listenerPlugin = {
  command: '__antilink_listener',

  async run({ sock, message, text, isGroup }) {
    if (!isGroup || message?.key?.fromMe) return

    try {
      const msgId = message?.key?.id
      const jid = message?.key?.remoteJid
      const sender = message?.key?.participant || message?.participant

      if (!msgId || !jid || !sender) return
      if (processedMsgs.has(msgId)) return

      processedMsgs.add(msgId)
      setTimeout(() => processedMsgs.delete(msgId), 60000)

      const settings = await getSettings(jid)
      if (!settings.enabled) return

      const { limit, cooldown, allowed, mode } = settings
      if (!isUrl(text)) return
      if (allowed.some(link => text.includes(link))) return

      // 1. Check Admin status first
      const meta = await sock.groupMetadata(jid).catch(() => null)
      if (!meta) return

      const senderBase = sender.split(':')[0]
      const isAdmin = meta.participants.some(p => p.id?.split(':')[0] === senderBase && Boolean(p.admin))

      // 2. If mode is 'warn' (members only) and sender is admin, ignore completely.
      if (mode === 'warn' && isAdmin) return

      // 3. Delete the message (happens for members in all modes, and admins in 'all' mode)
      await sock.sendMessage(jid, {
        delete: {
          remoteJid: jid,
          fromMe: false,
          id: msgId,
          participant: sender
        }
      }).catch(err => console.log('[ANTILINK DELETE ERROR]', err.message))

      // 🚀 FIX 1: Admin links are deleted, but admins are NEVER warned or kicked.
      if (isAdmin) return

      // --- MEMBER LOGIC ---
      const key = `${jid}_${sender}`
      const now = Date.now()

      if (!lastTime[key] || now - lastTime[key] > cooldown) {
        linkCount[key] = 0
        delete warned[key]
      }

      lastTime[key] = now
      linkCount[key] = (linkCount[key] || 0) + 1

      if (linkCount[key] >= limit) {
        // Kick the member after limit
        await sock.groupParticipantsUpdate(jid, [sender], 'remove')
          .catch(err => console.log('[ANTILINK KICK ERROR]', err.message))

        delete linkCount[key]
        delete lastTime[key]
        delete warned[key]
        return
      }

      // 🚀 FIX 2: If mode is 'null', do NOT warn. Just return.
      if (mode !== 'null' && !warned[key]) {
        warned[key] = true
        await sock.sendMessage(jid, {
          text: `@${sender.split('@')[0]} _${toSmallCaps('links are not allowed here. this is your only warning.')}_ ⚠️`,
          mentions: [sender]
        })
      }
    } catch (err) {
      console.log('[ANTILINK LISTENER ERROR]', err.message)
    }
  }
}

export default slinkPlugin
