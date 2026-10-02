import { getDb, saveDb } from '../database/index.js'

const DB_KEY = 'goodbye.json'

function getSettings(jid) {
  const db = getDb(DB_KEY)

  if (!db[jid]) {
    db[jid] = {
      enabled: false,
      text: '👋 *𝐆ᴏᴏᴅʙʏᴇ ғʀᴏᴍ* &group\n\n📌 &mention\n\n_ᴘᴏᴡᴇʀᴇᴅ ʙʏ ʀᴀᴢᴀ ʙᴏᴛ_'
    }
    saveDb(DB_KEY, db)
  }

  return db[jid]
}

export const goodbyeCommand = {
  command: ['goodbye', 'setgoodbye'],

  async run({ sock, message, args, isOwner, isGroup, isAdmin }) {
    if (!isGroup) return

    if (!isOwner && !isAdmin) {
      return sock.sendMessage(
        message.key.remoteJid,
        { text: '❌ 𝐎ɴʟʏ 𝐀ᴅᴍɪɴs 𝐂ᴀɴ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ.' },
        { quoted: message }
      )
    }

    const jid = message.key.remoteJid
    const db = getDb(DB_KEY)
    const settings = getSettings(jid)
    const action = args[0]?.toLowerCase()

    if (!action) {
      return sock.sendMessage(
        jid,
        {
          text:
            `╭─❒ 𝐆ᴏᴏᴅʙʏᴇ 𝐒ᴇᴛᴛɪɴɢs ❒\n` +
            `│\n` +
            `│ 𝐒ᴛᴀᴛᴜs : ${settings.enabled ? '𝐎ɴ' : '𝐎ғғ'}\n` +
            `│\n` +
            `│ 𝐎ɴ\n` +
            `│ 𝐎ғғ\n` +
            `│ 𝐆ᴇᴛ\n` +
            `│ 𝐑ᴇsᴇᴛ\n` +
            `│ 𝐒ᴇᴛ <message>\n` +
            `╰──────────────`
        },
        { quoted: message }
      )
    }

    if (action === 'on') {
      settings.enabled = true
      db[jid] = settings
      saveDb(DB_KEY, db)

      return sock.sendMessage(
        jid,
        { text: '✅ 𝐆ᴏᴏᴅʙʏᴇ 𝐌ᴇssᴀɢᴇ 𝐄ɴᴀʙʟᴇ' },
        { quoted: message }
      )
    }

    if (action === 'off') {
      settings.enabled = false
      db[jid] = settings
      saveDb(DB_KEY, db)

      return sock.sendMessage(
        jid,
        { text: '❌ 𝐆ᴏᴏᴅʙʏᴇ 𝐌ᴇssᴀɢᴇ 𝐃ɪsᴀʙʟᴇ' },
        { quoted: message }
      )
    }

    if (action === 'get') {
      return sock.sendMessage(
        jid,
        {
          text:
            `╭─❒ 𝐆ᴏᴏᴅʙʏᴇ 𝐌ᴇssᴀɢᴇ ❒\n` +
            `│\n${settings.text}\n` +
            `╰──────────────`
        },
        { quoted: message }
      )
    }

    if (action === 'reset') {
      settings.text =
        '👋 *𝐆ᴏᴏᴅʙʏᴇ ғʀᴏᴍ* &group\n\n📌 &mention\n\n_ᴘᴏᴡᴇʀᴇᴅ ʙʏ ʀᴀᴢᴀ ʙᴏᴛ_'

      db[jid] = settings
      saveDb(DB_KEY, db)

      return sock.sendMessage(
        jid,
        { text: '✅ 𝐆ᴏᴏᴅʙʏᴇ 𝐌ᴇssᴀɢᴇ 𝐑ᴇsᴇᴛ' },
        { quoted: message }
      )
    }

    if (action === 'set') {
      const text = args.slice(1).join(' ').trim()

      if (!text) {
        return sock.sendMessage(
          jid,
          { text: '❌ 𝐏ʟᴇᴀsᴇ 𝐏ʀᴏᴠɪᴅᴇ 𝐀 𝐌ᴇssᴀɢᴇ.' },
          { quoted: message }
        )
      }

      settings.text = text
      db[jid] = settings
      saveDb(DB_KEY, db)

      return sock.sendMessage(
        jid,
        { text: '✅ 𝐆ᴏᴏᴅʙʏᴇ 𝐌ᴇssᴀɢᴇ 𝐒ᴀᴠᴇᴅ' },
        { quoted: message }
      )
    }
  }
}

export const goodbyeListener = {
  command: '__goodbye_listener',

  async run({ sock, update }) {
    const { id, participants, action } = update

    if (!id || !participants || action !== 'remove') return

    const settings = getSettings(id)

    if (!settings.enabled) return

    const groupMetadata = await sock.groupMetadata(id)
    const groupName = groupMetadata.subject || '𝐆ʀᴏᴜᴘ'

    for (const userJid of participants) {
      const text = settings.text
        .replace(/&mention/g, `@${userJid.split('@')[0]}`)
        .replace(/&group/g, groupName)

      await sock.sendMessage(id, {
        text,
        mentions: [userJid]
      })
    }
  }
}

export default goodbyeCommand
