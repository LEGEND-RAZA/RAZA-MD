import {
  downloadContentFromMessage,
  prepareWAMessageMedia,
  generateWAMessageFromContent,
  jidNormalizedUser
} from '@whiskeysockets/baileys'

async function downloadMedia(message, type) {
  const stream =
    await downloadContentFromMessage(
      message,
      type
    )

  const chunks = []

  for await (const chunk of stream) {
    chunks.push(chunk)
  }

  return Buffer.concat(chunks)
}

async function prepareStatusMedia(
  quotedMessage,
  sock
) {
  if (quotedMessage?.imageMessage) {
    const media =
      await downloadMedia(
        quotedMessage.imageMessage,
        'image'
      )

    const prepared =
      await prepareWAMessageMedia(
        {
          image: media,
          mimetype:
            quotedMessage.imageMessage.mimetype ||
            'image/jpeg'
        },
        {
          upload: sock.waUploadToServer
        }
      )

    if (prepared.imageMessage) {
      prepared.imageMessage.caption =
        quotedMessage.imageMessage.caption || ''
    }

    return prepared
  }

  if (quotedMessage?.videoMessage) {
    const media =
      await downloadMedia(
        quotedMessage.videoMessage,
        'video'
      )

    const prepared =
      await prepareWAMessageMedia(
        {
          video: media,
          mimetype:
            quotedMessage.videoMessage.mimetype ||
            'video/mp4'
        },
        {
          upload: sock.waUploadToServer
        }
      )

    if (prepared.videoMessage) {
      prepared.videoMessage.caption =
        quotedMessage.videoMessage.caption || ''
    }

    return prepared
  }

  if (quotedMessage?.audioMessage) {
    const media =
      await downloadMedia(
        quotedMessage.audioMessage,
        'audio'
      )

    return await prepareWAMessageMedia(
      {
        audio: media,
        mimetype:
          quotedMessage.audioMessage.mimetype ||
          'audio/ogg; codecs=opus',
        ptt:
          quotedMessage.audioMessage.ptt || false
      },
      {
        upload: sock.waUploadToServer
      }
    )
  }

  const text =
    quotedMessage?.conversation ||
    quotedMessage?.extendedTextMessage?.text

  if (text) {
    return {
      extendedTextMessage: {
        text
      }
    }
  }

  return null
}

async function sendGroupStatus(
  sock,
  groupJid,
  statusMessage
) {
  const userJid =
    jidNormalizedUser(
      sock.user?.id
    )

  const msg =
    generateWAMessageFromContent(
      groupJid,
      {
        groupStatusMessageV2: {
          message: statusMessage
        }
      },
      {
        userJid
      }
    )

  await sock.relayMessage(
    groupJid,
    msg.message,
    {
      messageId: msg.key.id
    }
  )
}

async function getGroups(sock) {
  const groups =
    await sock.groupFetchAllParticipating()

  return Object.keys(groups)
    .filter(
      jid => jid.endsWith('@g.us')
    )
}

export default {
  command: [
    'gst',
    'gggg'
  ],

  async run({
    sock,
    message,
    quotedMessage,
    command,
    args
  }) {
    const jid =
      message?.key?.remoteJid

    if (!jid) return

    if (!quotedMessage) {
      return await sock.sendMessage(
        jid,
        {
          text:
            '❌ 𝐑ᴇᴘʟʏ 𝐓ᴏ 𝐀 𝐓ᴇxᴛ, 𝐈ᴍᴀɢᴇ, 𝐕ɪᴅᴇᴏ ᴏʀ 𝐀ᴜᴅɪᴏ'
        },
        {
          quoted: message
        }
      )
    }

    try {
      const statusMessage =
        await prepareStatusMedia(
          quotedMessage,
          sock
        )

      if (!statusMessage) {
        return await sock.sendMessage(
          jid,
          {
            text:
              '❌ 𝐔ɴsᴜᴘᴘᴏʀᴛᴇᴅ 𝐌ᴇᴅɪᴀ 𝐓ʏᴘᴇ'
          },
          {
            quoted: message
          }
        )
      }

      /*
       * =========================
       * .GST
       * POST ON EVERY GROUP
       * =========================
       */

      if (command === 'gst') {
        const groupJids =
          await getGroups(sock)

        let success = 0
        let failed = 0

        for (
          const groupJid of groupJids
        ) {
          try {
            await sendGroupStatus(
              sock,
              groupJid,
              statusMessage
            )

            success++

            console.log(
              `[GST] Posted: ${groupJid}`
            )

            await new Promise(
              resolve =>
                setTimeout(
                  resolve,
                  500
                )
            )

          } catch (error) {
            failed++

            console.error(
              `[GST] Failed: ${groupJid}`,
              error?.message || error
            )
          }
        }

        return await sock.sendMessage(
          jid,
          {
            text:
              `╭─❒ ɢʀᴏᴜᴘ sᴛᴀᴛᴜs ❒\n` +
              `│\n` +
              `│ ᴛᴏᴛᴀʟ: ${groupJids.length}\n` +
              `│ sᴜᴄᴄᴇss: ${success}\n` +
              `│ ғᴀɪʟᴇᴅ: ${failed}\n` +
              `╰──────────────`
          },
          {
            quoted: message
          }
        )
      }

      /*
       * =========================
       * .GGGG
       * SPECIFIC GROUP
       * MULTIPLE TIMES
       * =========================
       */

      if (command === 'gggg') {
        let targetJid =
          jid

        let count = 1

        if (args[0]) {
          if (
            args[0].endsWith('@g.us')
          ) {
            targetJid =
              args[0]

            count =
              Number(args[1]) || 1
          } else {
            count =
              Number(args[0]) || 1
          }
        }

        if (
          !targetJid.endsWith('@g.us')
        ) {
          return await sock.sendMessage(
            jid,
            {
              text:
                '❌ 𝐆ʀᴏᴜᴘ 𝐉ɪᴅ 𝐑ᴇǫᴜɪʀᴇᴅ\n\n' +
                '𝐄xᴀᴍᴘʟᴇ:\n' +
                '.gggg 120363xxxx@g.us 5'
            },
            {
              quoted: message
            }
          )
        }

        count =
          Math.max(
            1,
            Math.min(
              count,
              50
            )
          )

        let success = 0
        let failed = 0

        for (
          let i = 0;
          i < count;
          i++
        ) {
          try {
            await sendGroupStatus(
              sock,
              targetJid,
              statusMessage
            )

            success++

            console.log(
              `[GGGG] Posted ${i + 1}/${count}: ${targetJid}`
            )

            if (
              i < count - 1
            ) {
              await new Promise(
                resolve =>
                  setTimeout(
                    resolve,
                    500
                  )
              )
            }

          } catch (error) {
            failed++

            console.error(
              `[GGGG] Failed: ${targetJid}`,
              error?.message || error
            )
          }
        }

        return await sock.sendMessage(
          jid,
          {
            text:
              `╭─❒ ɢɢɢɢ ❒\n` +
              `│\n` +
              `│ ɢʀᴏᴜᴘ: ${targetJid}\n` +
              `│ ᴛᴏᴛᴀʟ: ${count}\n` +
              `│ sᴜᴄᴄᴇss: ${success}\n` +
              `│ ғᴀɪʟᴇᴅ: ${failed}\n` +
              `╰──────────────`
          },
          {
            quoted: message
          }
        )
      }

    } catch (error) {
      console.error(
        '[GST/GGGG ERROR]',
        error
      )

      return await sock.sendMessage(
        jid,
        {
          text:
            `❌ ɢsᴛ ғᴀɪʟᴇᴅ\n\n` +
            `${error?.message || error}`
        },
        {
          quoted: message
        }
      )
    }
  }
}