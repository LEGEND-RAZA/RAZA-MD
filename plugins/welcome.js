import { getDb, saveDb } from '../database/index.js'

const DB_KEY = 'welcome.json'

// Clean Unicode Escape Map for Small Caps
function toSmallCaps(text) {
  const smallCapsMap = {
    a: '\u1D00', b: '\u0299', c: '\u1D04', d: '\u1D05', e: '\u1D07',
    f: '\u0493', g: '\u0262', h: '\u029C', i: '\u026A', j: '\u1D0A',
    k: '\u1D0B', l: '\u029F', m: '\u1D0D', n: '\u0274', o: '\u1D0F',
    p: '\u1D18', q: '\u01FA', r: '\u0280', s: 's',      t: '\u1D1B',
    u: '\u1D1C', v: '\u1D20', w: '\u1D21', x: 'x',      y: '\u028F',
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
      text: `👋 *${toSmallCaps('welcome to')}* &group\n\n📌 &mention\n\n_${toSmallCaps('powered by raza bot')}_`
    }
    saveDb(DB_KEY, storage)
  }
  return storage[jid]
}

// ⚙️ COMMAND PANEL (!welcome on / off / set <msg> / reset / get)
export const welcomeCommand = {
  command: ['welcome', 'setwelcome'],
  description: 'Manage group welcome messages',
  async run({ sock, message, args, isGroup, isOwner }) {
    const jid = message.key.remoteJid
    if (!isGroup) return

    const groupMetadata = await sock.groupMetadata(jid).catch(() => null)
    if (!groupMetadata) return

    const sender = message.key.participant || jid
    const isAdmin = groupMetadata.participants.some((p) => p.id === sender && p.admin !== null)

    if (!isAdmin && !isOwner) return

    const cmd = args[0]?.toLowerCase()
    const storage = getDb(DB_KEY, {})
    const settings = getSettings(jid)

    // Toggle ON
    if (cmd === 'on') {
      settings.enabled = true
      storage[jid] = settings
      saveDb(DB_KEY, storage)
      return await sock.sendMessage(jid, { text: `✅ ${toSmallCaps('welcome message enabled')}` }, { quoted: message })
    }

    // Toggle OFF
    if (cmd === 'off') {
      settings.enabled = false
      storage[jid] = settings
      saveDb(DB_KEY, storage)
      return await sock.sendMessage(jid, { text: `❌ ${toSmallCaps('welcome message disabled')}` }, { quoted: message })
    }

    // Set Custom Message
    if (cmd === 'set') {
      const customMsg = args.slice(1).join(' ').trim()
      if (!customMsg) {
        return await sock.sendMessage(
          jid,
          { text: `⚠️ ${toSmallCaps('please provide a text message.')}\n\n*${toSmallCaps('example')}:*\n!welcome set Welcome &mention to &group!` },
          { quoted: message }
        )
      }
      settings.text = customMsg
      settings.enabled = true
      storage[jid] = settings
      saveDb(DB_KEY, storage)
      return await sock.sendMessage(jid, { text: `✅ ${toSmallCaps('welcome message updated successfully!')}` }, { quoted: message })
    }

    // View Current Settings
    if (cmd === 'get') {
      return await sock.sendMessage(jid, { text: `📌 *${toSmallCaps('current welcome message')}*:\n\n${settings.text}` }, { quoted: message })
    }

    // Reset to Default
    if (cmd === 'reset') {
      settings.text = `👋 *${toSmallCaps('welcome to')}* &group\n\n📌 &mention\n\n_${toSmallCaps('powered by raza bot')}_`
      storage[jid] = settings
      saveDb(DB_KEY, storage)
      return await sock.sendMessage(jid, { text: `✅ ${toSmallCaps('welcome message reset to default.')}` }, { quoted: message })
    }

    // Help Panel
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

    await sock.sendMessage(jid, { text: menu }, { quoted: message })
  }
}

// 🔔 PASSIVE GROUP EVENT LISTENER
export const welcomeListener = {
  command: '__welcome_listener',
  async run({ sock, update }) {
    const { id, participants, action } = update
    const storage = getDb(DB_KEY, {})
    const settings = storage[id]

    if (!settings || !settings.enabled) return

    if (action === 'add') {
      const groupMetadata = await sock.groupMetadata(id).catch(() => null)
      const groupName = groupMetadata?.subject || 'Group'

      for (const item of participants) {
        const userJid = typeof item === 'string' ? item : item?.id || ''
        if (!userJid) continue

        const text = settings.text
          .replace(/&mention/g, `@${userJid.split('@')[0]}`)
          .replace(/&group/g, groupName)

        await sock.sendMessage(id, { text, mentions: [userJid] }).catch((err) => console.log('Welcome Send Error:', err))
      }
    }
  }
}

export default welcomeCommand