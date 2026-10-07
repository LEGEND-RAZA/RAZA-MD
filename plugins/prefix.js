export default {
  command: 'prefix',
  category: 'owner',
  description: 'Change or check the bot command prefix',

  async run({
    sock,
    message,
    args,
    isOwner
  }) {
    const jid =
      message?.key?.remoteJid

    if (!jid) return

    if (!isOwner) {
      return await sock.sendMessage(
        jid,
        {
          text:
            '❌ ᴏɴʟʏ ᴛʜᴇ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴄʜᴀɴɢᴇ ᴛʜᴇ ᴘʀᴇғɪx.'
        },
        {
          quoted: message
        }
      )
    }

    const currentPrefix =
      process.env.PREFIX || '.'

    const newPrefix =
      args?.[0]?.trim()

    if (!newPrefix) {
      return await sock.sendMessage(
        jid,
        {
          text:
            `⚙️ *ᴄᴜʀʀᴇɴᴛ ᴘʀᴇғɪx:* [ ${currentPrefix} ]\n\n` +
            `*ᴜsᴀɢᴇ:* ${currentPrefix}prefix <ɴᴇᴡ_ᴘʀᴇғɪx>`
        },
        {
          quoted: message
        }
      )
    }

    const API_KEY =
      process.env.HEROKU_API_KEY

    const APP_NAME =
      process.env.HEROKU_APP_NAME

    if (!API_KEY || !APP_NAME) {
      return await sock.sendMessage(
        jid,
        {
          text:
            '❌ ʜᴇʀᴏᴋᴜ ᴄᴏɴғɪɢᴜʀᴀᴛɪᴏɴ ɪs ᴍɪssɪɴɢ.\n\n' +
            `HEROKU_API_KEY: ${
              API_KEY ? '✓' : '✗'
            }\n` +
            `HEROKU_APP_NAME: ${
              APP_NAME ? '✓' : '✗'
            }`
        },
        {
          quoted: message
        }
      )
    }

    try {
      const response =
        await fetch(
          `https://api.heroku.com/apps/${encodeURIComponent(
            APP_NAME
          )}/config-vars`,
          {
            method: 'PATCH',
            headers: {
              Authorization:
                `Bearer ${API_KEY}`,
              Accept:
                'application/vnd.heroku+json; version=3',
              'Content-Type':
                'application/json'
            },
            body: JSON.stringify({
              PREFIX: newPrefix
            })
          }
        )

      const data =
        await response.json().catch(
          () => ({})
        )

      if (!response.ok) {
        throw new Error(
          data?.message ||
          data?.error ||
          `Heroku API error: HTTP ${response.status}`
        )
      }

      process.env.PREFIX =
        newPrefix

      return await sock.sendMessage(
        jid,
        {
          text:
            `✅ *ᴘʀᴇғɪx sᴜᴄᴄᴇssғᴜʟʟʏ ᴜᴘᴅᴀᴛᴇᴅ ᴛᴏ* [ ${newPrefix} ]\n\n` +
            `☁️ ʜᴇʀᴏᴋᴜ ᴄᴏɴғɪɢ ᴠᴀʀ ᴜᴘᴅᴀᴛᴇᴅ\n` +
            `⚙️ PREFIX=${newPrefix}\n` +
            `🔄 ᴀᴘᴘ ᴡɪʟʟ ʀᴇsᴛᴀʀᴛ ᴀᴜᴛᴏᴍᴀᴛɪᴄᴀʟʟʏ`
        },
        {
          quoted: message
        }
      )

    } catch (error) {
      console.error(
        '[PREFIX] Error:',
        error?.message || error
      )

      return await sock.sendMessage(
        jid,
        {
          text:
            '❌ ᴜɴᴀʙʟᴇ ᴛᴏ ᴜᴘᴅᴀᴛᴇ ᴘʀᴇғɪx\n\n' +
            `${error?.message || error}`
        },
        {
          quoted: message
        }
      )
    }
  }
}
