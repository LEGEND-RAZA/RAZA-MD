import {
  downloadContentFromMessage
} from '@whiskeysockets/baileys'

export default {
  command: ['spam'],

  description:
    'Send text or media multiple times',

  async run({
    sock,
    message,
    args,
    isOwner
  }) {
    if (!isOwner) return

    const jid =
      message?.key?.remoteJid

    if (!jid) return

    let input =
      Array.isArray(args)
        ? [...args]
        : String(args || '')
            .split(/\s+/)
            .filter(Boolean)

    let targetJid = jid

    if (
      input.length &&
      input[input.length - 1].includes('@')
    ) {
      targetJid = input.pop()
    }

    if (!input.length) {
      return await sock.sendMessage(
        jid,
        {
          text:
            '❌ 𝐏ʀᴏᴠɪᴅᴇ 𝐓ʜᴇ 𝐂ᴏᴜɴᴛ'
        },
        {
          quoted: message
        }
      )
    }

    const count =
      parseInt(
        input[input.length - 1]
      )

    if (isNaN(count)) {
      return await sock.sendMessage(
        jid,
        {
          text:
            '❌ 𝐏ʀᴏᴠɪᴅᴇ 𝐀 𝐕ᴀʟɪᴅ 𝐂ᴏᴜɴᴛ'
        },
        {
          quoted: message
        }
      )
    }

    input.pop()

    if (count < 1) {
      return await sock.sendMessage(
        jid,
        {
          text:
            '❌ 𝐂ᴏᴜɴᴛ 𝐌ᴜsᴛ 𝐁ᴇ 𝐀ᴛ 𝐋ᴇᴀsᴛ 𝟏'
        },
        {
          quoted: message
        }
      )
    }

    if (count > 1000) {
      return await sock.sendMessage(
        jid,
        {
          text:
            '❌ 𝐋ɪᴍɪᴛ 𝐈s 𝟏𝟎𝟎𝟎'
        },
        {
          quoted: message
        }
      )
    }

    const cmdText =
      input.join(' ')

    let mentions = []

    if (
      targetJid.endsWith('@g.us')
    ) {
      try {
        const group =
          await sock.groupMetadata(
            targetJid
          )

        mentions =
          group.participants.map(
            p => p.id
          )
      } catch {}
    }

    const context =
      message?.message
        ?.extendedTextMessage
        ?.contextInfo

    const quoted =
      context?.quotedMessage

    if (quoted) {
      const mediaMessage =
        quoted.imageMessage ||
        quoted.videoMessage ||
        quoted.audioMessage ||
        quoted.documentMessage ||
        quoted.stickerMessage

      let buffer = null

      if (mediaMessage) {
        try {
          let type = 'document'

          if (quoted.imageMessage)
            type = 'image'
          else if (quoted.videoMessage)
            type = 'video'
          else if (quoted.audioMessage)
            type = 'audio'
          else if (quoted.stickerMessage)
            type = 'sticker'

          const stream =
            await downloadContentFromMessage(
              mediaMessage,
              type
            )

          const chunks = []

          for await (
            const chunk of stream
          ) {
            chunks.push(chunk)
          }

          buffer =
            Buffer.concat(chunks)
        } catch {}
      }

      const originalCaption =
        quoted.imageMessage?.caption ||
        quoted.videoMessage?.caption ||
        ''

      const originalText =
        quoted.conversation ||
        quoted.extendedTextMessage?.text ||
        ''

      for (
        let i = 0;
        i < count;
        i++
      ) {
        try {
          if (
            quoted.imageMessage &&
            buffer
          ) {
            await sock.sendMessage(
              targetJid,
              {
                image: buffer,
                caption: originalCaption,
                mentions
              }
            )
          }

          else if (
            quoted.videoMessage &&
            buffer
          ) {
            await sock.sendMessage(
              targetJid,
              {
                video: buffer,
                caption: originalCaption,
                mentions
              }
            )
          }

          else if (
            quoted.audioMessage &&
            buffer
          ) {
            await sock.sendMessage(
              targetJid,
              {
                audio: buffer,
                mimetype:
                  quoted.audioMessage.mimetype ||
                  'audio/mpeg',
                ptt:
                  quoted.audioMessage.ptt ||
                  false
              }
            )
          }

          else if (
            quoted.documentMessage &&
            buffer
          ) {
            await sock.sendMessage(
              targetJid,
              {
                document: buffer,
                mimetype:
                  quoted.documentMessage.mimetype ||
                  'application/octet-stream',
                fileName:
                  quoted.documentMessage.fileName ||
                  'file'
              }
            )
          }

          else if (
            quoted.stickerMessage &&
            buffer
          ) {
            await sock.sendMessage(
              targetJid,
              {
                sticker: buffer
              }
            )
          }

          else if (originalText) {
            await sock.sendMessage(
              targetJid,
              {
                text: originalText,
                mentions
              }
            )
          }

        } catch {
          continue
        }
      }

      return
    }

    if (!cmdText) {
      return await sock.sendMessage(
        jid,
        {
          text:
            '❌ 𝐏ʀᴏᴠɪᴅᴇ 𝐓ᴇxᴛ 𝐀ɴᴅ 𝐂ᴏᴜɴᴛ'
        },
        {
          quoted: message
        }
      )
    }

    for (
      let i = 0;
      i < count;
      i++
    ) {
      try {
        await sock.sendMessage(
          targetJid,
          {
            text: cmdText,
            mentions
          }
        )
      } catch {
        continue
      }
    }
  }
}