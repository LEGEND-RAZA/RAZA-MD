export default {
  command: ['deploy', 'update', 'redeploy'],
  category: 'owner',
  description: 'Deploy Raza-MD to a Heroku app',

  async run({ sock, message, args, isOwner }) {
    if (!isOwner) return

    const jid = message?.key?.remoteJid
    if (!jid) return

    const API_KEY = process.env.HEROKU_API_KEY

    if (!API_KEY) {
      return await sock.sendMessage(
        jid,
        {
          text:
            '❌ ʜᴇʀᴏᴋᴜ ᴀᴘɪ ᴋᴇʏ ɪs ᴍɪssɪɴɢ.\n\n' +
            'sᴇᴛ ʜᴇʀᴏᴋᴜ_ᴀᴘɪ_ᴋᴇʏ ɪɴ ᴛʜᴇ ᴄᴜʀʀᴇɴᴛ ʙᴏᴛ ᴀᴘᴘ.'
        },
        {
          quoted: message
        }
      )
    }

    const appName = args?.[0]?.trim()
    const sessionId = args?.[1]?.trim()

    if (!appName || !sessionId) {
      return await sock.sendMessage(
        jid,
        {
          text:
            '❌ ɪɴᴠᴀʟɪᴅ ᴜsᴀɢᴇ\n\n' +
            'ᴜsᴇ:\n' +
            '.ᴅᴇᴘʟᴏʏ <ᴀᴘᴘɴᴀᴍᴇ> <sᴇssɪᴏɴɪᴅ>\n\n' +
            'ᴇxᴀᴍᴘʟᴇ:\n' +
            '.ᴅᴇᴘʟᴏʏ ʀᴀᴢᴀ-ᴍᴅ ʀᴀᴢᴀ_xxxxxxxx'
        },
        {
          quoted: message
        }
      )
    }

    const REPO = 'LEGEND-RAZA/RAZA-MD'
    const BRANCH = 'main'
    const PAIR_SERVER_URL =
      process.env.PAIR_SERVER_URL ||
      'https://pair-web-3e08f4e68faf.herokuapp.com'

    const headers = {
      Authorization: `Bearer ${API_KEY}`,
      Accept: 'application/vnd.heroku+json; version=3',
      'Content-Type': 'application/json'
    }

    const apiBase =
      `https://api.heroku.com/apps/${encodeURIComponent(appName)}`

    const sourceUrl =
      `https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz`

    try {
      await sock.sendMessage(
        jid,
        {
          text:
            '🚀 ʀᴀᴢᴀ-ᴍᴅ ᴅᴇᴘʟᴏʏ sᴛᴀʀᴛᴇᴅ\n\n' +
            `📦 ʀᴇᴘᴏ: ${REPO}\n` +
            `🌿 ʙʀᴀɴᴄʜ: ${BRANCH}\n` +
            `☁️ ᴀᴘᴘ: ${appName}\n\n` +
            '🔐 sᴇssɪᴏɴ ɪᴅ ᴘʀᴇᴘᴀʀɪɴɢ...\n' +
            '⏳ sᴛᴀʀᴛɪɴɢ ʙᴜɪʟᴅ...'
        },
        {
          quoted: message
        }
      )

      const configResponse = await fetch(
        `${apiBase}/config-vars`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            SESSION_ID: sessionId,
            PAIR_SERVER_URL,
            PREFIX: '.'
          })
        }
      )

      const configData =
        await configResponse.json().catch(() => ({}))

      if (!configResponse.ok) {
        throw new Error(
          configData?.message ||
          configData?.error ||
          `config vars failed: HTTP ${configResponse.status}`
        )
      }

      const buildResponse = await fetch(
        `${apiBase}/builds`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            source_blob: {
              url: sourceUrl,
              version_description:
                `Raza-MD deploy from ${REPO}@${BRANCH}`
            }
          })
        }
      )

      const buildData =
        await buildResponse.json().catch(() => ({}))

      if (!buildResponse.ok) {
        throw new Error(
          buildData?.message ||
          buildData?.error ||
          `build failed: HTTP ${buildResponse.status}`
        )
      }

      const buildId =
        buildData?.id || 'unknown'

      await sock.sendMessage(
        jid,
        {
          text:
            '✅ ʀᴀᴢᴀ-ᴍᴅ ᴅᴇᴘʟᴏʏ ᴄʀᴇᴀᴛᴇᴅ\n\n' +
            `☁️ ᴀᴘᴘ: ${appName}\n` +
            `📦 ʙᴜɪʟᴅ: ${buildId}\n` +
            `🌿 ʙʀᴀɴᴄʜ: ${BRANCH}\n` +
            '🔐 sᴇssɪᴏɴ_ɪᴅ: ᴜᴘᴅᴀᴛᴇᴅ\n' +
            `📊 sᴛᴀᴛᴜs: ${buildData?.status || 'pending'}\n\n` +
            '🔄 ᴛʜᴇ ᴀᴘᴘ ᴡɪʟʟ ʀᴇsᴛᴀʀᴛ ᴀғᴛᴇʀ ᴛʜᴇ ɴᴇᴡ ʀᴇʟᴇᴀsᴇ.'
        },
        {
          quoted: message
        }
      )
    } catch (error) {
      console.error(
        '[DEPLOY ERROR]:',
        error?.message || error
      )

      return await sock.sendMessage(
        jid,
        {
          text:
            '❌ ʀᴀᴢᴀ-ᴍᴅ ᴅᴇᴘʟᴏʏ ғᴀɪʟᴇᴅ\n\n' +
            `${error?.message || 'unknown error'}`
        },
        {
          quoted: message
        }
      )
    }
  }
}
