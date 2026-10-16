import { getDb, saveDb } from '../database/index.js'

const DB_KEY = 'welcome.json'

// Shared across plugin reloads in the same Node.js process.
const processedEvents =
globalThis.__razaWelcomeProcessedEvents ||
(globalThis.__razaWelcomeProcessedEvents = new Map())

function toSmallCaps(text) {
const smallCapsMap = {
a: '\u1D00', b: '\u0299', c: '\u1D04', d: '\u1D05', e: '\u1D07',
f: '\u0493', g: '\u0262', h: '\u029C', i: '\u026A', j: '\u1D0A',
k: '\u1D0B', l: '\u029F', m: '\u1D0D', n: '\u0274', o: '\u1D0F',
p: '\u1D18', q: '\u01FA', r: '\u0280', s: 's', t: '\u1D1B',
u: '\u1D1C', v: '\u1D20', w: '\u1D21', x: 'x', y: '\u028F',
z: '\u1D22'
}

return String(text || '')
.toLowerCase()
.split('')
.map((char) => smallCapsMap[char] || char)
.join('')
}

function getSettings(jid) {
const storage = getDb(DB_KEY, {})

if (!storage[jid]) {
storage[jid] = {
enabled: false,
text:
"👋 *${toSmallCaps('welcome to')}* &group\n\n" +
"📌 &mention\n\n" +
"_${toSmallCaps('powered by raza bot')}_"
}

saveDb(DB_KEY, storage)

}

return storage[jid]
}

function normalizeJid(value) {
if (typeof value !== 'string' || !value) return ''

const at = value.lastIndexOf('@')
if (at < 0) return value

const user = value.slice(0, at).split(':')[0]
const server = value.slice(at + 1)

return user && server ? "${user}@${server}" : ''
}

function isAdminParticipant(participant, sender) {
const senderIds = new Set([
normalizeJid(sender)
])

const participantIds = [
participant?.id,
participant?.jid,
participant?.lid
]
.map(normalizeJid)
.filter(Boolean)

return (
participantIds.some((id) => senderIds.has(id)) &&
Boolean(participant?.admin)
)
}

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

const sender =
  message?.key?.participant ||
  sock?.user?.id ||
  ''

const isAdmin = groupMetadata.participants.some(
  (participant) => isAdminParticipant(participant, sender)
)

if (!isAdmin && !isOwner) return

const cmd = args?.[0]?.toLowerCase()
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
          `!welcome set Welcome &mention to &group!`
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
    {
      text: `✅ ${toSmallCaps('welcome message updated successfully!')}`
    },
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
  settings.text =
    `👋 *${toSmallCaps('welcome to')}* &group\n\n` +
    `📌 &mention\n\n` +
    `_${toSmallCaps('powered by raza bot')}_`

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
  `├ \`.welcome on\` - Enable welcome\n` +
  `├ \`.welcome off\` - Disable welcome\n` +
  `├ \`.welcome set <text>\` - Set custom welcome text\n` +
  `├ \`.welcome get\` - View current text\n` +
  `└ \`.welcome reset\` - Reset text\n\n` +
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

export const welcomeListener = {
command: '__welcome_listener',

async run({ sock, update }) {
if (!update) return

const { id, participants, action } = update

if (
  !id ||
  action !== 'add' ||
  !Array.isArray(participants) ||
  !participants.length
) {
  return
}

const storage = getDb(DB_KEY, {})
const settings = storage[id]

if (!settings?.enabled || !settings.text) return

const participantIds = [
  ...new Set(
    participants
      .map((item) =>
        typeof item === 'string'
          ? item
          : item?.id || item?.jid || ''
      )
      .map(normalizeJid)
      .filter(Boolean)
  )
].sort()

if (!participantIds.length) return

const eventKey = `${id}:add:${participantIds.join(',')}`
const now = Date.now()

// Clean up old event keys.
for (const [key, timestamp] of processedEvents) {
  if (now - timestamp > 120000) {
    processedEvents.delete(key)
  }
}

// Register the event before awaiting anything.
if (processedEvents.has(eventKey)) return

processedEvents.set(eventKey, now)

// Prevent the map growing indefinitely.
if (processedEvents.size > 1000) {
  const oldestKey = processedEvents.keys().next().value
  if (oldestKey) processedEvents.delete(oldestKey)
}

try {
  const metadata = await sock
    .groupMetadata(id)
    .catch(() => null)

  const groupName = metadata?.subject || 'Group'

  for (const userJid of participantIds) {
    const mention = `@${userJid.split('@')[0]}`

    const text = settings.text
      .replace(/&mention/g, mention)
      .replace(/&group/g, groupName)

    await sock.sendMessage(id, {
      text,
      mentions: [userJid]
    })
  }
} catch (err) {
  console.error(
    '[WELCOME ERROR]',
    err?.message || err
  )
}

}
}

export default welcomeCommand
