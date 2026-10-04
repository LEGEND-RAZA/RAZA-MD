export default {
  command: ['deploy'],
  category: 'owner',
  description: 'Create or deploy Raza-MD on Heroku',

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
            'sᴇᴛ ʜᴇʀᴏᴋᴜ_ᴀᴘɪ_ᴋᴇʏ ɪɴ ᴛʜᴇ ʙᴏᴛ ᴀᴘᴘ.'
        },
        { quoted: message }
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
            '.ᴅᴇᴘʟᴏʏ ʙᴜɴɴʏ3737 ʀᴀᴢᴀ_xxxxxxxx'
        },
        { quoted: message }
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

    const apiRoot = 'https://api.heroku.com'

    const sourceUrl =
      `https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz`

    try {
      let appResponse = await fetch(
        `${apiRoot}/apps/${encodeURIComponent(appName)}`,
        {
          method: 'GET',
          headers
        }
      )

      let appData =
        await appResponse.json().catch(() => ({}))

      let created = false

      /*
       * CREATE APP
       */

      if (appResponse.status === 404) {
        const createResponse = await fetch(
          `${apiRoot}/apps`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              name: appName,
              stack: 'heroku-24'
            })
          }
        )

        const createData =
          await createResponse.json().catch(() => ({}))

        if (!createResponse.ok) {
          throw new Error(
            createData?.message ||
            createData?.error ||
            `App creation failed: HTTP ${createResponse.status}`
          )
        }

        appData = createData
        created = true
        appResponse = createResponse
      }

      if (!appResponse.ok && !created) {
        if (
          appResponse.status === 401 ||
          appResponse.status === 403
        ) {
          throw new Error(
            `You do not have permission to access or create the app "${appName}".`
          )
        }

        throw new Error(
          appData?.message ||
          appData?.error ||
          `Unable to access app: HTTP ${appResponse.status}`
        )
      }

      const actualAppName =
        appData?.name || appName

      const apiBase =
        `${apiRoot}/apps/${encodeURIComponent(actualAppName)}`

      /*
       * START MESSAGE
       */

      await sock.sendMessage(
        jid,
        {
          text:
            '🚀 ʀᴀᴢᴀ-ᴍᴅ ᴅᴇᴘʟᴏʏ sᴛᴀʀᴛᴇᴅ\n\n' +
            `☁️ ᴀᴘᴘ: ${actualAppName}\n` +
            `📦 ʀᴇᴘᴏ: ${REPO}\n` +
            `🌿 ʙʀᴀɴᴄʜ: ${BRANCH}\n` +
            `${created ? '🆕 ɴᴇᴡ ᴀᴘᴘ: ᴄʀᴇᴀᴛᴇᴅ\n' : ''}` +
            '\n🔐 sᴇssɪᴏɴ ɪᴅ ᴘʀᴇᴘᴀʀɪɴɢ...\n' +
            '⏳ sᴛᴀʀᴛɪɴɢ ʙᴜɪʟᴅ...'
        },
        { quoted: message }
      )

      /*
       * CONFIG VARS
       */

      const configVars = {
        SESSION_ID: sessionId,

        PAIR_SERVER_URL,

        PREFIX:
          process.env.PREFIX || '.',

        HEROKU_API_KEY:
          process.env.HEROKU_API_KEY || '',

        HEROKU_APP_NAME:
          actualAppName,

        DB_HOST:
          process.env.DB_HOST ||
          'mysql-raza123-innoxcentraza-9801.c.aivencloud.com',

        DB_PORT:
          process.env.DB_PORT ||
          '19244',

        DB_NAME:
          process.env.DB_NAME ||
          'defaultdb',

        DB_USER:
          process.env.DB_USER ||
          'avnadmin',

        DB_PASSWORD:
          process.env.DB_PASSWORD || 'AVNS_bNdClU_igW6ULgky-vH'
      }

      const configResponse = await fetch(
        `${apiBase}/config-vars`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify(configVars)
        }
      )

      const configData =
        await configResponse.json().catch(() => ({}))

      if (!configResponse.ok) {
        throw new Error(
          configData?.message ||
          configData?.error ||
          `Config update failed: HTTP ${configResponse.status}`
        )
      }

      /*
       * BUILD
       */

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
          `Build failed: HTTP ${buildResponse.status}`
        )
      }

      const buildId =
        buildData?.id || 'unknown'

      /*
       * WORKER FORMATION
       */

      const formationResponse = await fetch(
        `${apiBase}/formation`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            updates: [
              {
                type: 'web',
                quantity: 0,
                dyno_size: {
                  name: 'basic'
                }
              },
              {
                type: 'worker',
                quantity: 1,
                dyno_size: {
                  name: 'basic'
                }
              }
            ]
          })
        }
      )

      const formationData =
        await formationResponse.json().catch(() => ({}))

      if (!formationResponse.ok) {
        throw new Error(
          formationData?.message ||
          formationData?.error ||
          `Worker formation failed: HTTP ${formationResponse.status}`
        )
      }

      /*
       * SUCCESS
       */

      await sock.sendMessage(
        jid,
        {
          text:
            '✅ ʀᴀᴢᴀ-ᴍᴅ ᴅᴇᴘʟᴏʏ ᴄʀᴇᴀᴛᴇᴅ\n\n' +
            `☁️ ᴀᴘᴘ: ${actualAppName}\n` +
            `📦 ʙᴜɪʟᴅ: ${buildId}\n` +
            `🌿 ʙʀᴀɴᴄʜ: ${BRANCH}\n` +
            '🔐 sᴇssɪᴏɴ_ɪᴅ: ᴜᴘᴅᴀᴛᴇᴅ\n' +
            '🗄️ ᴅᴀᴛᴀʙᴀsᴇ: ᴄᴏɴғɪɢᴜʀᴇᴅ\n' +
            '⚙️ ᴘʀᴏᴄᴇss: ᴡᴏʀᴋᴇʀ\n' +
            '▶️ ᴄᴏᴍᴍᴀɴᴅ: ɴᴏᴅᴇ ɪɴᴅᴇx.ᴊs\n' +
            '🌐 ᴡᴇʙ: ᴅɪsᴀʙʟᴇᴅ\n' +
            '🔢 ᴡᴏʀᴋᴇʀ: 1\n' +
            `📊 sᴛᴀᴛᴜs: ${buildData?.status || 'pending'}\n\n` +
            '🔄 ʀᴀᴢᴀ-ᴍᴅ ᴡɪʟʟ ʀᴜɴ ᴀs ᴀ ᴡᴏʀᴋᴇʀ.'
        },
        { quoted: message }
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
        { quoted: message }
      )
    }
  }
}
