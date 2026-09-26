import { getDb, saveDb } from '../database/index.js'

const DB_KEY = 'antilink.json'

const DEFAULTS = {
  enabled: false,
  limit: 6,
  cooldown: 2 * 60 * 1000,
  allowed: [],
  mode: 'warn'
}

const linkCount = {}
const lastTime = {}
const warned = {}
const processedMsgs = new Set()

function toSmallCaps(text) {
  const map = {
    a: '\u1D00', b: '\u0299', c: '\u1D04', d: '\u1D05', e: '\u1D07',
    f: '\u0493', g: '\u0262', h: '\u029C', i: '\u026A', j: '\u1D0A',
    k: '\u1D0B', l: '\u029F', m: '\u1D0D', n: '\u0274', o: '\u1D0F',
    p: '\u1D18', q: 'q', r: '\u0280', s: 's', t: '\u1D1B',
    u: '\u1D1C', v: '\u1D20', w: '\u1D21', x: 'x', y: '\u028F',
    z: '\u1D22'
  }

  return String(text || '')
    .toLowerCase()
    .split('')
    .map((c) => map[c] || c)
    .join('')
}

function getSettings(jid) {
  const storage = getDb(DB_KEY, {})

  if (!storage[jid]) {
    storage[jid] = { ...DEFAULTS }
    saveDb(DB_KEY, storage)
  }

  return storage[jid]
}

function saveSettings(jid, newData) {
  const storage = getDb(DB_KEY, {})
  const current = getSettings(jid)

  storage[jid] = { ...current, ...newData }
  saveDb(DB_KEY, storage)

  return storage[jid]
}

function isUrl(text) {
  if (!text) return false

  return text.split(/\s+/).some(
    (word) =>
      /(https?:\/\/[^\s]+|chat\.whatsapp\.com\/[^\s]+|wa\.me\/[^\s]+|whatsapp\.com\/channel\/[^\s]+)/i.test(word) &&
      (word.includes('chat.whatsapp.com') ||
        word.includes('wa.me') ||
        word.includes('whatsapp.com/channel'))
  )
}

export const slinkPlugin = {
  command: ['antilink'],

  async run({ sock, message, args, isGroup, isOwner }) {
    const jid = message.key.remoteJid

    if (!isGroup) {
      return await sock.sendMessage(
        jid,
        { text: `❌ ${toSmallCaps('this command can only be used in groups.')}` },
        { quoted: message }
      )
    }

    const groupMetadata = await sock.groupMetadata(jid).catch(() => null)
    if (!groupMetadata) return

    const sender = message.key.participant || jid
    const isAdmin = groupMetadata.participants.some(
      (p) => p.id === sender && p.admin !== null
    )

    if (!isAdmin && !isOwner) {
      return await sock.sendMessage(
        jid,
        { text: `❌ ${toSmallCaps('only group admins can use this command.')}` },
        { quoted: message }
      )
    }

    const cmd = args[0]?.toLowerCase()
    const data = getSettings(jid)

    if (!cmd) {
      return await sock.sendMessage(
        jid,
        {
          text:
            `⚙️ *${toSmallCaps('anti-link settings')}*\n\n` +
            `• *${toSmallCaps('status')}:* ${data.enabled ? 'ON' : 'OFF'}\n` +
            `• *${toSmallCaps('mode')}:* ${toSmallCaps(data.mode)}\n` +
            `• *${toSmallCaps('limit')}:* ${data.limit}\n` +
            `• *${toSmallCaps('cooldown')}:* ${data.cooldown / 1000}s\n` +
            `• *${toSmallCaps('allowed')}:*\n${data.allowed.join('\n') || toSmallCaps('no allowed links')}`
        },
        { quoted: message }
      )
    }

    if (cmd === 'on') {
      saveSettings(jid, { enabled: true })

      return await sock.sendMessage(
        jid,
        { text: `✅ _${toSmallCaps('anti-link enabled')}_` },
        { quoted: message }
      )
    }

    if (cmd === 'off') {
      saveSettings(jid, { enabled: false })

      return await sock.sendMessage(
        jid,
        { text: `❌ _${toSmallCaps('anti-link disabled')}_` },
        { quoted: message }
      )
    }

    if (cmd === 'null') {
      saveSettings(jid, { mode: 'null' })

      return await sock.sendMessage(
        jid,
        { text: `⚙️ _${toSmallCaps('mode set to null (delete only)')}_` },
        { quoted: message }
      )
    }

    if (cmd === 'warn') {
      saveSettings(jid, { mode: 'warn' })

      return await sock.sendMessage(
        jid,
        { text: `⚙️ _${toSmallCaps('mode set to warn (warn + delete)')}_` },
        { quoted: message }
      )
    }

    if (cmd === 'cooldown') {
      const num = parseInt(args[1])

      if (!isNaN(num) && num > 0) {
        saveSettings(jid, { cooldown: num * 1000 })

        return await sock.sendMessage(
          jid,
          { text: `⏱️ _${toSmallCaps(`cooldown set to ${num}s`)}_` },
          { quoted: message }
        )
      }
    }

    if (cmd === 'allow') {
      const link = args.slice(1).join(' ').trim()

      if (link) {
        const current = data.allowed || []

        if (!current.includes(link)) current.push(link)

        saveSettings(jid, { allowed: current })

        return await sock.sendMessage(
          jid,
          { text: `✅ _${toSmallCaps('link added to allowed list')}_` },
          { quoted: message }
        )
      }
    }

    if (cmd === 'remove') {
      const link = args.slice(1).join(' ').trim()

      if (link) {
        const current = data.allowed || []
        const filtered = current.filter((l) => l !== link)

        saveSettings(jid, { allowed: filtered })

        return await sock.sendMessage(
          jid,
          { text: `✅ _${toSmallCaps('link removed from allowed list')}_` },
          { quoted: message }
        )
      }
    }

    const num = parseInt(cmd)

    if (!isNaN(num) && num > 0) {
      saveSettings(jid, { limit: num })

      return await sock.sendMessage(
        jid,
        { text: `⚙️ _${toSmallCaps(`limit set to ${num}`)}_` },
        { quoted: message }
      )
    }

    return await sock.sendMessage(
      jid,
      { text: `⚠️ _${toSmallCaps('invalid command')}_` },
      { quoted: message }
    )
  }
}

export const listenerPlugin = {
  command: '__antilink_listener',

  async run({ sock, message, text, isGroup }) {
    if (!isGroup || message.key.fromMe) return

    try {
      const msgId = message.key.id

      if (processedMsgs.has(msgId)) return

      processedMsgs.add(msgId)
      setTimeout(() => processedMsgs.delete(msgId), 60000)

      const jid = message.key.remoteJid
      const sender = message.key.participant || message.participant

      if (!sender) return

      const settings = getSettings(jid)

      if (!settings.enabled) return

      const { limit, cooldown, allowed, mode } = settings
      const hasLink = isUrl(text)

      if (!hasLink) return

      if (allowed && allowed.some((link) => text.includes(link))) return

      await sock
        .sendMessage(jid, {
          delete: {
            remoteJid: jid,
            fromMe: false,
            id: msgId,
            participant: sender
          }
        })
        .catch((err) => console.log('AntiLink Delete Error:', err))

      const meta = await sock.groupMetadata(jid).catch(() => null)

      if (!meta) return

      const admins = meta.participants
        .filter((p) => p.admin !== null)
        .map((p) => p.id)

      if (admins.includes(sender)) return

      const key = `${jid}_${sender}`
      const now = Date.now()

      if (!lastTime[key] || now - lastTime[key] > cooldown) {
        linkCount[key] = 0
        delete warned[key]
      }

      lastTime[key] = now
      linkCount[key] = (linkCount[key] || 0) + 1

      if (linkCount[key] >= limit) {
        await sock
          .groupParticipantsUpdate(jid, [sender], 'remove')
          .catch((err) => console.log('AntiLink Kick Error:', err))

        delete linkCount[key]
        delete lastTime[key]
        delete warned[key]

        return
      }

      if (mode === 'warn' && linkCount[key] < limit && !warned[key]) {
        warned[key] = true

        await sock.sendMessage(jid, {
          text: `@${sender.split('@')[0]} _${toSmallCaps('link allow ni han so again link na aye')}_ 🙂⚠️`,
          mentions: [sender]
        })
      }
    } catch (err) {
      console.log('AntiLink Listener Error:', err)
    }
  }
}

export default slinkPlugin