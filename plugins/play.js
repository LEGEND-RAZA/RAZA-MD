import fetch from 'node-fetch'

export default {
  command: ['play'],

  description:
    'Play Music Using Sayan Official API',

  async run({
    sock,
    message,
    args
  }) {
    const jid =
      message?.key?.remoteJid

    if (!jid) return

    const query =
      args?.join(' ')?.trim()

    if (!query) {
      return await sock.sendMessage(
        jid,
        {
          text:
            '𝐄ɴᴛᴇʀ 𝐓ʜᴇ 𝐒ᴏɴɢ 𝐍ᴀᴍᴇ\n\n𝐄xᴀᴍᴘʟᴇ: .play Saiyaara'
        },
        {
          quoted: message
        }
      )
    }

    let statusMsg

    try {
      statusMsg =
        await sock.sendMessage(
          jid,
          {
            text:
              `🔍 *𝐒ᴇᴀʀᴄʜɪɴɢ ៚ ${query} ...*`
          },
          {
            quoted: message
          }
        )

      const apiUrl =
        `https://api.sayan-nexuswork.workers.dev/music?query=${encodeURIComponent(query)}`

      const response =
        await fetch(apiUrl)

      if (!response.ok) {
        throw new Error(
          `API HTTP ${response.status}`
        )
      }

      const data =
        await response.json()

      if (
        data?.status !== 'success' ||
        !data?.url
      ) {
        try {
          await sock.sendMessage(
            jid,
            {
              text:
                '🛠️ *𝐎ᴜʀ 𝐒ᴇʀᴠᴇʀ 𝐈s 𝐅ᴀᴄɪɴɢ 𝐀 𝐒ᴍᴀʟʟ 𝐈ssᴜᴇ 𝐑ɪɢʜᴛ 𝐍ᴏᴡ....*',
              edit: statusMsg?.key
            }
          )
        } catch {}

        return
      }

      const title =
        data.title ||
        query

      try {
        await sock.sendMessage(
          jid,
          {
            text:
              `⬇️ *𝐃ᴏᴡɴʟᴏᴀᴅɪɴɢ ៚ ${title} ...*`,
            edit:
              statusMsg?.key
          }
        )
      } catch {}

      const audioResponse =
        await fetch(data.url, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            'Referer':
              'https://www.youtube.com/'
          }
        })

      if (!audioResponse.ok) {
        throw new Error(
          `Audio HTTP ${audioResponse.status}`
        )
      }

      const arrayBuffer =
        await audioResponse.arrayBuffer()

      const audioBuffer =
        Buffer.from(arrayBuffer)

      try {
        await sock.sendMessage(
          jid,
          {
            text:
              `🎧 *𝐏ʟᴀʏɪɴɢ ៚ ${title} ...*`,
            edit:
              statusMsg?.key
          }
        )
      } catch {}

      await sock.sendMessage(
        jid,
        {
          audio: audioBuffer,
          mimetype: 'audio/mpeg',
          fileName:
            `${title}.mp3`,
          ptt: false
        }
      )

    } catch (error) {
      console.error(
        '[PLAY ERROR]:',
        error
      )

      try {
        await sock.sendMessage(
          jid,
          {
            text:
              '❌ *𝐓ʜᴇʀᴇ 𝐈s 𝐀 𝐏ʀᴏʙʟᴇᴍ 𝐖ɪᴛʜ 𝐓ʜᴇ 𝐒ᴇʀᴠᴇʀ 𝐑ɪɢʜᴛ 𝐍ᴏᴡ.....*',
            edit:
              statusMsg?.key
          }
        )
      } catch {
        await sock.sendMessage(
          jid,
          {
            text:
              '❌ *𝐓ʜᴇʀᴇ 𝐈s 𝐀 𝐏ʀᴏʙʟᴇᴍ 𝐖ɪᴛʜ 𝐓ʜᴇ 𝐒ᴇʀᴠᴇʀ 𝐑ɪɢʜᴛ 𝐍ᴏᴡ.....*'
          },
          {
            quoted: message
          }
        )
      }
    }
  }
}
