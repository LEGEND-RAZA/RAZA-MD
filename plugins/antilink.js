
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

// Prevent concurrent setting updates from overwriting one another.
let settingsQueue = Promise.resolve()

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

  return String(text || '')
    .toLowerCase()
    .split('')
    .map(c => map[c] || c)
    .join('')
}

function getSettings(jid) {
  const storage = getDb(DB_KEY, {})

  if (!storage[jid]) {
    storage[jid] = structuredClone(DEFAULTS)

    // Persist default settings without blocking the synchronous getter.
    saveDb(DB_KEY, storage).catch(err => {
      console.error('[ANTILINK DEFAULT SAVE ERROR]', err.message)
    })
  }

  // Fill missing properties when loading older saved settings.
  storage[jid] = {
    ...structuredClone(DEFAULTS),
    ...storage[jid],
    allowed: Array.isArray(storage[jid].allowed)
      ? storage[jid].allowed
      : []
  }

  return storage[jid]
}

async function saveSettings(jid, newData) {
  // Serialize setting changes to avoid overlapping read-modify-write updates.
  const operation = settingsQueue
    .catch(() => {})
    .then(async () => {
      const storage = getDb(DB_KEY, {})
      const current = getSettings(jid)

      storage[jid] = {
        ...current,
        ...newData
      }

      await saveDb(DB_KEY, storage)

      return storage[jid]
    })

  settingsQueue = operation
  return operation
}

function isUrl(text) {
  if (!text) return false

  return text.split(/\s+/).some(word =>
    /(https?:\/\/[^\s]+|chat\.whatsapp\.com\/[^\s]+|wa\.me\/[^\s]+|whatsapp\.com\/channel\/[^\s]+)/i.test(word) &&
    /(chat\.whatsapp\.com|wa\.me|whatsapp\.com\/channel)/i.test(word)
  )
}

async function sendSaveError(sock, jid, message) {
  console.error('[ANTILINK SETTINGS ERROR]', message)

  await sock.sendMessage(jid, {
    text: `❌ ${toSmallCaps('could not save settings to database. please try again.')}`
  }).catch(() => {})
}

export const slinkPlugin = {
  command: ['antilink'],
  category: 'group',

  async run({ sock, message, args, isGroup, isOwner }) {
    const jid = message?.key?.remoteJid
    if (!jid) return

    if (!isGroup) {
      return sock.sendMessage(
        jid,
        { text: `❌ ${toSmallCaps('this command can only be used in groups.')}` },
        { quoted: message }
      )
    }

    const groupMetadata = await sock.groupMetadata(jid).catch(() => null)
    if (!groupMetadata) return

    const sender = message.key.participant || jid
    const senderBase = sender.split(':')[0]

    const isAdmin = groupMetadata.participants.some(p =>
      p.id?.split(':')[0] === senderBase && Boolean(p.admin)
    )

    if (!isAdmin && !isOwner) {
      return sock.sendMessage(
        jid,
        { text: `❌ ${toSmallCaps('only group admins can use this command.')}` },
        { quoted: message }
      )
    }

    const cmd = args[0]?.toLowerCase()
    const data = getSettings(jid)

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
            `• *${toSmallCaps('allowed')}:*\n${data.allowed.join('\n') || toSmallCaps('no allowed links')}`
        },
        { quoted: message }
      )
    }

    let update
    let successText

    if (cmd === 'on') {
      update = { enabled: true }
      successText = `✅ _${toSmallCaps('anti-link enabled')}_`
    } else if (cmd === 'off') {
      update = { enabled: false }
      successText = `❌ _${toSmallCaps('anti-link disabled')}_`
    } else if (cmd === 'null') {
      update = { mode: 'null' }
      successText = `⚙️ _${toSmallCaps('mode set to null (delete only)')}_`
    } else if (cmd === 'warn') {
      update = { mode: 'warn' }
      successText = `⚙️ _${toSmallCaps('mode set to warn (warn + delete)')}_`
    } else if (cmd === 'cooldown') {
      const num = Number.parseInt(args[1], 10)

      if (!Number.isFinite(num) || num <= 0) {
        return sock.sendMessage(
          jid,
          { text: `⚠️ ${toSmallCaps('use: antilink cooldown <seconds>')}` },
          { quoted: message }
        )
      }

      update = { cooldown: num * 1000 }
      successText = `⏱️ _${toSmallCaps(`cooldown set to ${num}s`)}_`
    } else if (cmd === 'allow') {
      const link = args.slice(1).join(' ').trim()

      if (!link) {
        return sock.sendMessage(
          jid,
          { text: `⚠️ ${toSmallCaps('use: antilink allow <link>')}` },
          { quoted: message }
        )
      }

      const allowed = [...(data.allowed || [])]
      if (!allowed.includes(link)) allowed.push(link)

      update = { allowed }
      successText = `✅ _${toSmallCaps('link added to allowed list')}_`
    } else if (cmd === 'remove') {
      const link = args.slice(1).join(' ').trim()

      if (!link) {
        return sock.sendMessage(
          jid,
          { text: `⚠️ ${toSmallCaps('use: antilink remove <link>')}` },
          { quoted: message }
        )
      }

      update = {
        allowed: (data.allowed || []).filter(item => item !== link)
      }
      successText = `✅ _${toSmallCaps('link removed from allowed list')}_`
    } else {
      const num = Number.parseInt(cmd, 10)

      if (!Number.isFinite(num) || num <= 0) {
        return sock.sendMessage(
          jid,
          { text: `⚠️ _${toSmallCaps('invalid command')}_` },
          { quoted: message }
        )
      }

      update = { limit: num }
      successText = `⚙️ _${toSmallCaps(`limit set to ${num}`)}_`
    }

    try {
      await saveSettings(jid, update)

      return sock.sendMessage(
        jid,
        { text: successText },
        { quoted: message }
      )
    } catch (err) {
      await sendSaveError(sock, jid, err.message)
    }
  }
}

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

      const settings = getSettings(jid)
      if (!settings.enabled) return

      const { limit, cooldown, allowed, mode } = settings
      if (!isUrl(text)) return
      if (allowed.some(link => text.includes(link))) return

      await sock.sendMessage(jid, {
        delete: {
          remoteJid: jid,
          fromMe: false,
          id: msgId,
          participant: sender
        }
      }).catch(err => console.log('[ANTILINK DELETE ERROR]', err.message))

      const meta = await sock.groupMetadata(jid).catch(() => null)
      if (!meta) return

      const senderBase = sender.split(':')[0]
      const admins = meta.participants
        .filter(p => Boolean(p.admin))
        .map(p => p.id?.split(':')[0])

      if (admins.includes(senderBase)) return

      const key = `${jid}_${sender}`
      const now = Date.now()

      if (!lastTime[key] || now - lastTime[key] > cooldown) {
        linkCount[key] = 0
        delete warned[key]
      }

      lastTime[key] = now
      linkCount[key] = (linkCount[key] || 0) + 1

      if (linkCount[key] >= limit) {
        await sock.groupParticipantsUpdate(jid, [sender], 'remove')
          .catch(err => console.log('[ANTILINK KICK ERROR]', err.message))

        delete linkCount[key]
        delete lastTime[key]
        delete warned[key]
        return
      }

      if (mode === 'warn' && !warned[key]) {
        warned[key] = true

        await sock.sendMessage(jid, {
          text: `@${sender.split('@')[0]} _${toSmallCaps('link allow ni han so again link na aye')}_ 🙂⚠️`,
          mentions: [sender]
        })
      }
    } catch (err) {
      console.log('[ANTILINK LISTENER ERROR]', err)
    }
  }
}

export default slinkPlugin
