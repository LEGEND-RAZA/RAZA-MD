import * as baileys from '@whiskeysockets/baileys'

export const bv = {
  command: ['bv'],

  async run({ sock, message, isOwner }) {
    if (!isOwner) return

    const jid = message?.key?.remoteJid
    if (!jid) return

    try {
      const pkg = await import('@whiskeysockets/baileys/package.json', {
        with: { type: 'json' }
      })

      const keys = Object.keys(baileys).filter((key) =>
        /status|group/i.test(key)
      )

      await sock.sendMessage(
        jid,
        {
          text:
            `╭─❒ ʙᴀɪʟᴇʏs ᴄʜᴇᴄᴋ ❒\n` +
            `│\n` +
            `│ ᴠᴇʀsɪᴏɴ: ${pkg.default?.version || pkg.version || 'Unknown'}\n` +
            `│\n` +
            `│ sᴛᴀᴛᴜs/ɢʀᴏᴜᴘ ᴇxᴘᴏʀᴛs:\n` +
            `│ ${keys.length ? keys.join(', ') : 'ɴᴏɴᴇ ғᴏᴜɴᴅ'}\n` +
            `│\n` +
            `╰──────────────`
        },
        { quoted: message }
      )
    } catch (error) {
      console.error('[BV]', error)

      await sock.sendMessage(
        jid,
        {
          text: `❌ ᴄʜᴇᴄᴋ ғᴀɪʟᴇᴅ:\n${error?.message || error}`
        },
        { quoted: message }
      )
    }
  }
}

export default bv