
import { getDb, saveDb } from '../database/index.js'

const DB_KEY = 'welcome.json'
const DEDUPE_KEY = '__razaWelcomeDedup'
const DEDUPE_WINDOW = 60_000

function toSmallCaps(text) {
  const smallCapsMap = {
    a: '\u1D00', b: '\u0299', c: '\u1D04', d: '\u1D05',
    e: '\u1D07', f: '\u0493', g: '\u0262', h: '\u029C',
    i: '\u026A', j: '\u1D0A', k: '\u1D0B', l: '\u029F',
    m: '\u1D0D', n: '\u0274', o: '\u1D0F', p: '\u1D18',
    q: '\u01FA', r: '\u0280', s: 's', t: '\u1D1B',
    u: '\u1D1C', v: '\u1D20', w: '\u1D21', x: 'x',
    y: '\u028F', z: '\u1D22'
  }

  return String(text || '')
    .toLowerCase()
    .split('')
    .map(char => smallCapsMap[char] || char)
    .join('')
}

function defaultWelcomeText() {
  return (
    `👋 *${toSmallCaps('welcome to')}* &group\n\n` +
    `📌 &mention\n\n` +
    `_${toSmallCaps('powered by raza bot')}_`
  )
}

function getSettings(jid) {
  const storage = getDb(DB_KEY, {})

  if (!storage[jid]) {
    storage[jid] = {
      enabled: false,
      text: defaultWelcomeText()
    }

    saveDb(DB_KEY, storage)
  }

  return storage[jid]
}

function normalizeJid(jid) {
  return String(jid || '').split(':')[0]
}

function getDedupeMap() {
  if (!(globalThis[DEDUPE_KEY] instanceof Map)) {
    globalThis[DEDUPE_KEY] = new Map()
  }

  return globalThis[DEDUPE_KEY]
}

function cleanDedupeMap(map, now) {
  for (const [key, timestamp] of map) {
    if (now - timestamp >= DEDUPE_WINDOW) {
      map.delete(key)
    }
  }
}

/*
 * ==============================
 * WELCOME COMMAND
 * ==============================
 */

export const welcomeCommand = {
  command: ['welcome', 'setwelcome'],
  category: 'group',
  description: 'Manage group welcome messages',

  async run({ sock, message, args, isGroup, isOwner }) {
    const jid = message?.key?.remoteJid

    if (!jid || !isGroup) return

    const groupMetadata = await sock
      .groupMetadata(jid)
      .catch(() => null)

    if (!groupMetadata) return

    const sender = normalizeJid(
      message?.key?.participant ||
      message?.key?.participantPn ||
      ''
    )

    const isAdmin = groupMetadata.participants.some(p => {
      const participantJid = normalizeJid(
        p.id || p.jid || ''
      )

      return (
        participantJid === sender &&
        (p.admin === 'admin' || p.admin === 'superadmin')
      )
    })

    if (!isAdmin && !isOwner) return

    const cmd = String(args?.[0] || '').toLowerCase()
    const storage = getDb(DB_KEY, {})
    const settings = getSettings(jid)

    if (cmd === 'on') {
      settings.enabled = true
      storage[jid] = settings
      saveDb(DB_KEY, storage)

      return sock.sendMessage(
        jid,
        { text: `✅ ${toSmallCaps('welcome message enabled')}` },
        { quoted: message }
      )
    }

    if (cmd === 'off') {
      settings.enabled = false
      storage[jid] = settings
      saveDb(DB_KEY, storage)

      return sock.sendMessage(
        jid,
        { text: `❌ ${toSmallCaps('welcome message disabled')}` },
        { quoted: message }
      )
    }

    if (cmd === 'set') {
      const customMsg = args.slice(1).join(' ').trim()

      if (!customMsg) {
        return sock.sendMessage(
          jid,
          {
            text:
              `⚠️ ${toSmallCaps('please provide a text message.')}\n\n` +
              `*${toSmallCaps('example')}:*\n` +
              `${getPrefixForExample()}welcome set Welcome &mention to &group!`
          },
          { quoted: message }
        )
      }

      settings.text = customMsg
      settings.enabled = true
      storage[jid] = settings
      saveDb(DB_KEY, storage)

      return sock.sendMessage(
        jid,
        { text: `✅ ${toSmallCaps('welcome message updated successfully!')}` },
        { quoted: message }
      )
    }

    if (cmd === 'get') {
      return sock.sendMessage(
        jid,
        {
          text:
            `📌 *${toSmallCaps('current welcome message')}:*\n\n` +
            settings.text
        },
        { quoted: message }
      )
    }

    if (cmd === 'reset') {
      settings.text = defaultWelcomeText()
      storage[jid] = settings
      saveDb(DB_KEY, storage)

      return sock.sendMessage(
        jid,
        {
          text: `✅ ${toSmallCaps('welcome message reset to default.')}`
        },
        { quoted: message }
      )
    }

    const status = settings.enabled ? 'ON' : 'OFF'

    const menu =
      `⚙️ *${toSmallCaps('welcome settings')}*\n\n` +
      `• *${toSmallCaps('status')}:* ${status}\n\n` +
      `*${toSmallCaps('commands')}:*\n` +
      `├ \`!welcome on\` - Enable welcome\n` +
      `├ \`!welcome off\` - Disable welcome\n` +
      `├ \`!welcome set <text>\` - Set custom welcome text\n` +
      `├ \`!welcome get\` - View current text\n` +
      `└ \`!welcome reset\` - Reset text\n\n` +
      `*${toSmallCaps('placeholders')}:*\n` +
      `• \`&mention\` - Tags new member\n` +
      `• \`&group\` - Group name`

    return sock.sendMessage(
      jid,
      { text: menu },
      { quoted: message }
    )
  }
}

function getPrefixForExample() {
  return process.env.PREFIX || '.'
}

/*
 * ==============================
 * WELCOME EVENT LISTENER
 * ==============================
 */

export const welcomeListener = {
  command: '__welcome_listener',

  async run({ sock, update }) {
    if (!sock || !update) return

    const { id, participants, action } = update

    if (
      !id ||
      action !== 'add' ||
      !Array.isArray(participants) ||
      participants.length === 0
    ) {
      return
    }

    const storage = getDb(DB_KEY, {})
    const settings = storage[id]

    if (!settings?.enabled) return

    // Normalize and deduplicate participants within this event.
    const userJids = [
      ...new Set(
        participants
          .map(item =>
            typeof item === 'string'
              ? item
              : item?.id || ''
          )
          .filter(Boolean)
          .map(normalizeJid)
          .filter(Boolean)
      )
    ]

    if (!userJids.length) return

    const now = Date.now()
    const processed = getDedupeMap()

    cleanDedupeMap(processed, now)

    // Claim each participant before any await, preventing overlapping
    // event handlers from sending the same welcome twice.
    const newUsers = userJids.filter(userJid => {
      const key = `${id}:${userJid}`
      const previousTime = processed.get(key)

      if (
        previousTime &&
        now - previousTime < DEDUPE_WINDOW
      ) {
        return false
      }

      processed.set(key, now)
      return true
    })

    if (!newUsers.length) return

    try {
      const metadata = await sock
        .groupMetadata(id)
        .catch(() => null)

      const groupName = metadata?.subject || 'Group'

      for (const userJid of newUsers) {
        const key = `${id}:${userJid}`

        try {
          // Read the latest saved text in case it was changed.
          const latestStorage = getDb(DB_KEY, {})
          const latestSettings = latestStorage[id]

          if (!latestSettings?.enabled) {
            processed.delete(key)
            continue
          }

          const template = String(
            latestSettings.text || defaultWelcomeText()
          )

          const text = template
            .replace(/&mention/g, `@${userJid.split('@')[0]}`)
            .replace(/&group/g, groupName)

          await sock.sendMessage(id, {
            text,
            mentions: [userJid]
          })
        } catch (error) {
          // Allow a later event to retry if sending failed.
          processed.delete(key)

          console.error(
            '[Welcome Send Error]',
            error?.message || error
          )
        }
      }
    } catch (error) {
      // Release the claims if group metadata or another outer step fails.
      for (const userJid of newUsers) {
        processed.delete(`${id}:${userJid}`)
      }

      console.error(
        '[Welcome Listener Error]',
        error?.stack || error?.message || error
      )
    }
  }
}

export default welcomeCommand
