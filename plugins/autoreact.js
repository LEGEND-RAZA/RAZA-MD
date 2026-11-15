import { getDb, saveDb } from '../database/index.js'

const DB_KEY = 'autoreact.json'

// 🚀 NEW DEFAULT EMOJIS
const DEFAULT_EMOJIS = [
  '💋', '💗', '😚', '😋', '😫', '🫣', '🤭', '🤧', '👻', '😻', '😽', '🫶🏻', 
  '😾', '👀', '🫀', '🫂', '👑', '💍', '🙈', '🐣', '🦋', '🐋', '🐬', '🪽', 
  '🪶', '🦢', '🕊️', '☘️', '🍀', '🎋', '💐', '🌾', '🌷', '🌹', '🌸', '🌼', 
  '🌝', '🌚', '🌙', '🌍', '💫', '✨', '🔥', '🫧', '🍫', '🍿', '🍷', '🥂', 
  '🍸', '🫟', '💸', '💎', '🧸', '🎀', '🪄', '🔖', '🔏', '🩷', '🤍'
]

// Default settings structure
const DEFAULT_SETTINGS = {
  global: false,
  allGroups: false,
  allInboxes: false,
  specificGroups: [],
  specificInboxes: [],
  emojis: [...DEFAULT_EMOJIS] // Store emojis in DB
}

async function getSettings() {
  const data = await getDb(DB_KEY, DEFAULT_SETTINGS)
  // Ensure arrays exist
  if (!Array.isArray(data.specificGroups)) data.specificGroups = []
  if (!Array.isArray(data.specificInboxes)) data.specificInboxes = []
  if (!Array.isArray(data.emojis) || data.emojis.length === 0) data.emojis = [...DEFAULT_EMOJIS]
  return data
}

async function saveSettings(data) {
  await saveDb(DB_KEY, data)
}

function toSmallCaps(text) {
  const map = {
    a: '\u1D00', b: '\u0299', c: '\u1D04', d: '\u1D05', e: '\u1D07',
    f: '\u0493', g: '\u0262', h: '\u029C', i: '\u026A', j: '\u1D0A',
    k: '\u1D0B', l: '\u029F', m: '\u1D0D', n: '\u0274', o: '\u1D0F',
    p: '\u1D18', q: '\u01FA', r: '\u0280', s: 's',      t: '\u1D1B',
    u: '\u1D1C', v: '\u1D20', w: '\u1D21', x: 'x',      y: '\u028F',
    z: '\u1D22'
  }
  return String(text || '').toLowerCase().split('').map((c) => map[c] || c).join('')
}

/* =========================================================
   COMMAND HANDLER
   ========================================================= */
export const autoreactCommand = {
  command: ['autoreact', 'ar'],
  category: 'owner', // Restricted to owner to prevent spam abuse
  
  async run({ sock, message, args, isGroup, isOwner }) {
    const jid = message?.key?.remoteJid
    if (!jid) return

    // Only owner can change settings globally or for specific JIDs
    if (!isOwner) return

    const action = String(args[0] || '').trim().toLowerCase()
    const data = await getSettings()

    // Help Menu
    if (!action || action === 'status') {
      return sock.sendMessage(jid, {
        text:
          `╭─❒ ᴀᴜᴛᴏ ʀᴇᴀᴄᴛ ❒\n` +
          `│\n` +
          `│ ɢʟᴏʙᴀʟ (ᴀʟʟ): ${data.global ? 'ᴏɴ ✅' : 'ᴏғғ ❌'}\n` +
          `│ ᴀʟʟ ɢʀᴏᴜᴘs: ${data.allGroups ? 'ᴏɴ ✅' : 'ᴏғғ ❌'}\n` +
          `│ ᴀʟʟ ɪɴʙᴏx: ${data.allInboxes ? 'ᴏɴ ✅' : 'ᴏғғ ❌'}\n` +
          `│ sᴘᴇᴄɪғɪᴄ ɢʀᴏᴜᴘs: ${data.specificGroups.length}\n` +
          `│ sᴘᴇᴄɪғɪᴄ ɪɴʙᴏx: ${data.specificInboxes.length}\n` +
          `│ ᴇᴍᴏᴊɪs: ${data.emojis.length} ʟᴏᴀᴅᴇᴅ\n` +
          `│\n` +
          `│ ᴄᴏᴍᴍᴀɴᴅs:\n` +
          `│ .ar on / off (ɢʟᴏʙᴀʟ)\n` +
          `│ .ar groups on / off\n` +
          `│ .ar inbox on / off\n` +
          `│ .ar this on / off\n` +
          `│ .ar <ᴊɪᴅ> on / off\n` +
          `│ .ar emojis <ᴇᴍᴏᴊɪ1> <ᴇᴍᴏᴊɪ2> ...\n` +
          `│ .ar resetemojis\n` +
          `╰────────────`
      }, { quoted: message })
    }

    // Change Emojis (.ar emojis ❤️ 🔥 👍)
    if (action === 'emojis' || action === 'setemojis') {
      const newEmojis = args.slice(1)
      if (!newEmojis.length) {
        return sock.sendMessage(jid, { 
          text: `⚠️ ᴜsᴀɢᴇ: .ar emojis <ᴇᴍᴏᴊɪ1> <ᴇᴍᴏᴊɪ2> ...\nᴄᴜʀʀᴇɴᴛ ʟɪsᴛ ʜᴀs ${data.emojis.length} ᴇᴍᴏᴊɪs.` 
        })
      }
      
      data.emojis = newEmojis
      await saveSettings(data)
      return sock.sendMessage(jid, { 
        text: `✅ *${toSmallCaps('autoreact emojis updated')}*\n\n${data.emojis.join(' ')}` 
      })
    }

    // Reset Emojis (.ar resetemojis)
    if (action === 'resetemojis' || action === 'reset') {
      data.emojis = [...DEFAULT_EMOJIS]
      await saveSettings(data)
      return sock.sendMessage(jid, { 
        text: `✅ *${toSmallCaps('autoreact emojis reset to default list')}*` 
      })
    }

    // Global Toggle (.ar on / .ar off)
    if (action === 'on' || action === 'off') {
      data.global = action === 'on'
      await saveSettings(data)
      return sock.sendMessage(jid, { text: `✅ *${toSmallCaps(`autoreact ${action === 'on' ? 'enabled' : 'disabled'} globally (groups + inbox)`)}*` })
    }

    // All Groups Toggle (.ar groups on)
    if (action === 'groups') {
      const sub = String(args[1] || '').toLowerCase()
      if (sub === 'on' || sub === 'off') {
        data.allGroups = sub === 'on'
        await saveSettings(data)
        return sock.sendMessage(jid, { text: `✅ *${toSmallCaps(`autoreact ${sub === 'on' ? 'enabled' : 'disabled'} for ALL groups`)}*` })
      }
    }

    // All Inbox Toggle (.ar inbox on)
    if (action === 'inbox') {
      const sub = String(args[1] || '').toLowerCase()
      if (sub === 'on' || sub === 'off') {
        data.allInboxes = sub === 'on'
        await saveSettings(data)
        return sock.sendMessage(jid, { text: `✅ *${toSmallCaps(`autoreact ${sub === 'on' ? 'enabled' : 'disabled'} for ALL inboxes`)}*` })
      }
    }

    // Current Chat Toggle (.ar this on)
    if (action === 'this') {
      const sub = String(args[1] || '').toLowerCase()
      if (sub !== 'on' && sub !== 'off') return
      
      const isGroupChat = jid.endsWith('@g.us')
      const targetArray = isGroupChat ? data.specificGroups : data.specificInboxes
      
      if (sub === 'on') {
        if (!targetArray.includes(jid)) targetArray.push(jid)
      } else {
        const idx = targetArray.indexOf(jid)
        if (idx > -1) targetArray.splice(idx, 1)
      }
      
      await saveSettings(data)
      return sock.sendMessage(jid, { text: `✅ *${toSmallCaps(`autoreact ${sub === 'on' ? 'enabled' : 'disabled'} for this chat`)}*` })
    }

    // Specific JID Toggle (.ar 123@g.us on)
    if (action.includes('@')) {
      const targetJid = action
      const sub = String(args[1] || '').toLowerCase()

      if (sub === 'on' || sub === 'off') {
        const isGroupJid = targetJid.endsWith('@g.us')
        const targetArray = isGroupJid ? data.specificGroups : data.specificInboxes

        if (sub === 'on') {
          if (!targetArray.includes(targetJid)) targetArray.push(targetJid)
        } else {
          const idx = targetArray.indexOf(targetJid)
          if (idx > -1) targetArray.splice(idx, 1)
        }

        await saveSettings(data)
        return sock.sendMessage(jid, { text: `✅ *${toSmallCaps(`autoreact ${sub === 'on' ? 'enabled' : 'disabled'} for`)}* ${targetJid}` })
      }
    }

    return sock.sendMessage(jid, { text: '⚠️ ɪɴᴠᴀʟɪᴅ ᴄᴏᴍᴍᴀɴᴅ. ᴜsᴇ .ar ꜰᴏʀ ʜᴇʟᴘ.' })
  }
}

/* =========================================================
   LISTENER HANDLER (Background Auto-React)
   ========================================================= */
export const autoreactListener = {
  command: '__autoreact_listener',

  async run({ sock, message }) {
    try {
      if (!message?.key?.remoteJid) return
      if (message.key.fromMe) return // Don't react to your own messages
      
      const jid = message.key.remoteJid
      const isGroup = jid.endsWith('@g.us')

      const data = await getSettings()

      let shouldReact = false

      // Check rules
      if (data.global) {
        shouldReact = true
      } else if (isGroup && data.allGroups) {
        shouldReact = true
      } else if (!isGroup && data.allInboxes) {
        shouldReact = true
      } else if (isGroup && data.specificGroups.includes(jid)) {
        shouldReact = true
      } else if (!isGroup && data.specificInboxes.includes(jid)) {
        shouldReact = true
      }

      if (!shouldReact) return

      // Pick a random emoji from the custom list
      const emojis = data.emojis
      const emoji = emojis[Math.floor(Math.random() * emojis.length)]

      // React to the message
      await sock.sendMessage(jid, { 
        react: { text: emoji, key: message.key } 
      }).catch(() => {})

    } catch (error) {
      console.error('[AUTOREACT ERROR]', error.message)
    }
  }
}

export default autoreactCommand
