import {
  getDb,
  saveDb
} from '../database/index.js'

const DB_KEY = 'alinks_settings'

const sentLinks = new Set()

function loadSettings() {
  return getDb(
    DB_KEY,
    {
      targetJids: [],
      customMsg: '',
      enabled: false
    }
  )
}

function saveSettings(settings) {
  return saveDb(
    DB_KEY,
    settings
  )
}

const delay = ms =>
  new Promise(resolve =>
    setTimeout(resolve, ms)
  )

export default {
  command: 'alinks',
  category: 'tools',
  description:
    'Automatically collect and forward WhatsApp group links',

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
            '❌ ᴏɴʟʏ ᴛʜᴇ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴜsᴇ ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ.'
        },
        {
          quoted: message
        }
      )
    }

    const settings =
      loadSettings()

    const commandArgs =
      Array.isArray(args)
        ? args
        : []

    const cmd =
      commandArgs.shift()
        ?.trim()
        .toLowerCase()

    const value =
      commandArgs
        .join(' ')
        .trim()

    if (!cmd || cmd === 'check') {
      return await sock.sendMessage(
        jid,
        {
          text:
`╭───〔 ᴀʟɪɴᴋs 〕
│
│ sᴛᴀᴛᴜs:
│ ${settings.enabled ? 'ᴏɴ' : 'ᴏғғ'}
│
│ ᴛᴀʀɢᴇᴛs:
│ ${
  settings.targetJids.length
    ? settings.targetJids.join('\n│ ')
    : 'ɴᴏ ᴊɪᴅs'
}
│
│ ᴍᴇssᴀɢᴇ:
│ ${settings.customMsg || 'ɴᴏ ᴍᴇssᴀɢᴇ'}
│
╰──────────────`
        },
        {
          quoted: message
        }
      )
    }

    if (cmd === 'on') {
      settings.enabled = true

      saveSettings(settings)

      return await sock.sendMessage(
        jid,
        {
          text:
            '✅ ᴀʟɪɴᴋs ʜᴀs ʙᴇᴇɴ ᴇɴᴀʙʟᴇᴅ.'
        },
        {
          quoted: message
        }
      )
    }

    if (cmd === 'off') {
      settings.enabled = false

      saveSettings(settings)

      return await sock.sendMessage(
        jid,
        {
          text:
            '❌ ᴀʟɪɴᴋs ʜᴀs ʙᴇᴇɴ ᴅɪsᴀʙʟᴇᴅ.'
        },
        {
          quoted: message
        }
      )
    }

    if (cmd === 'add') {
      if (!value.includes('@')) {
        return await sock.sendMessage(
          jid,
          {
            text:
              '❌ ɪɴᴠᴀʟɪᴅ ᴊɪᴅ.'
          },
          {
            quoted: message
          }
        )
      }

      if (
        !settings.targetJids.includes(
          value
        )
      ) {
        settings.targetJids.push(
          value
        )

        saveSettings(settings)
      }

      return await sock.sendMessage(
        jid,
        {
          text:
            '✅ ᴊɪᴅ ᴀᴅᴅᴇᴅ ᴛᴏ ᴀʟɪɴᴋs.'
        },
        {
          quoted: message
        }
      )
    }

    if (
      cmd === 'del' ||
      cmd === 'remove'
    ) {
      settings.targetJids =
        settings.targetJids.filter(
          target =>
            target !== value
        )

      saveSettings(settings)

      return await sock.sendMessage(
        jid,
        {
          text:
            '❌ ᴊɪᴅ ʀᴇᴍᴏᴠᴇᴅ ғʀᴏᴍ ᴀʟɪɴᴋs.'
        },
        {
          quoted: message
        }
      )
    }

    if (cmd === 'msg') {
      settings.customMsg =
        value

      saveSettings(settings)

      return await sock.sendMessage(
        jid,
        {
          text:
            '✅ ᴀʟɪɴᴋs ᴍᴇssᴀɢᴇ ᴜᴘᴅᴀᴛᴇᴅ.'
        },
        {
          quoted: message
        }
      )
    }

    if (cmd === 'clear') {
      settings.targetJids = []
      settings.customMsg = ''

      saveSettings(settings)

      return await sock.sendMessage(
        jid,
        {
          text:
            '✅ ᴀʟɪɴᴋs sᴇᴛᴛɪɴɢs ᴄʟᴇᴀʀᴇᴅ.'
        },
        {
          quoted: message
        }
      )
    }

    return await sock.sendMessage(
      jid,
      {
        text:
`╭───〔 ᴀʟɪɴᴋs ʜᴇʟᴘ 〕
│
│ .ᴀʟɪɴᴋs ᴏɴ
│ .ᴀʟɪɴᴋs ᴏғғ
│ .ᴀʟɪɴᴋs ᴄʜᴇᴄᴋ
│
│ .ᴀʟɪɴᴋs ᴀᴅᴅ ᴊɪᴅ
│ .ᴀʟɪɴᴋs ᴅᴇʟ ᴊɪᴅ
│ .ᴀʟɪɴᴋs ʀᴇᴍᴏᴠᴇ ᴊɪᴅ
│
│ .ᴀʟɪɴᴋs ᴍsɢ ᴛᴇxᴛ
│
│ .ᴀʟɪɴᴋs ᴄʟᴇᴀʀ
│
╰──────────────`
      },
      {
        quoted: message
      }
    )
  }
}

export const __alinks_listener = {
  on: 'text',
  fromMe: false,

  async run({
    sock,
    message
  }) {
    try {
      const settings =
        loadSettings()

      if (!settings.enabled) return

      if (
        !settings.targetJids ||
        !settings.targetJids.length
      ) {
        return
      }

      const text =
        message?.text ||
        message?.body ||
        message?.message?.conversation ||
        message?.message?.extendedTextMessage?.text ||
        ''

      if (!text) return

      const regex =
        /https?:\/\/chat\.whatsapp\.com\/[0-9A-Za-z]+/gi

      const matches =
        text.match(regex)

      if (!matches) return

      await delay(1500)

      for (const link of matches) {
        if (
          sentLinks.has(link)
        ) {
          continue
        }

        const code =
          link
            .split('/')
            .pop()

        if (!code) continue

        try {
          /*
           * ==============================
           * GET GROUP INFORMATION
           * ==============================
           */

          const meta =
            await sock.groupGetInviteInfo(
              code
            )

          const groupName =
            meta?.subject ||
            'WhatsApp Group'

          const groupId =
            meta?.id

          /*
           * ==============================
           * GET GROUP PROFILE PICTURE
           * ==============================
           */

          let thumbBuffer = null

          if (groupId) {
            try {
              const ppUrl =
                await sock.profilePictureUrl(
                  groupId,
                  'preview'
                )

              if (ppUrl) {
                const response =
                  await fetch(
                    ppUrl
                  )

                if (response.ok) {
                  thumbBuffer =
                    Buffer.from(
                      await response.arrayBuffer()
                    )
                }
              }
            } catch {}
          }

          /*
           * ==============================
           * SEND TO ALL TARGETS
           * ==============================
           */

          for (
            const targetJid
            of settings.targetJids
          ) {
            const messageText =
`${settings.customMsg || ''}
${link}`

            const content = {
              text:
                messageText,

              linkPreview: {
                'matched-text':
                  link,

                title:
                  groupName,

                description:
                  `Invite to join "${groupName}"`,

                previewType: 0,

                ...(thumbBuffer
                  ? {
                      jpegThumbnail:
                        thumbBuffer
                    }
                  : {})
              },

              externalAdReply: {
                title:
                  groupName,

                body:
                  `Invite to join "${groupName}"`,

                mediaType: 1,

                renderLargerThumbnail:
                  true,

                ...(thumbBuffer
                  ? {
                      thumbnail:
                        thumbBuffer
                    }
                  : {}),

                sourceUrl:
                  link
              }
            }

            await sock.sendMessage(
              targetJid,
              content
            )
          }

          sentLinks.add(link)

          if (
            sentLinks.size > 500
          ) {
            sentLinks.clear()
          }

        } catch (error) {

          /*
           * ==============================
           * FALLBACK
           * ==============================
           */

          for (
            const targetJid
            of settings.targetJids
          ) {
            await sock.sendMessage(
              targetJid,
              {
                text:
`${settings.customMsg || ''}
${link}`
              }
            )
          }

          sentLinks.add(link)

          if (
            sentLinks.size > 500
          ) {
            sentLinks.clear()
          }
        }
      }

    } catch (error) {
      console.log(
        '[ALINKS]',
        error?.message ||
        error
      )
    }
  }
}
