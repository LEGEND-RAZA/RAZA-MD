import {
  downloadMediaMessage
} from '@whiskeysockets/baileys'

export default {
  command: 'tag',

  async run({
    sock,
    message,
    args,
    isGroup,
    isOwner
  }) {
    const jid =
      message?.key?.remoteJid

    if (!jid || !isGroup || !isOwner) return

    try {
      const metadata =
        await sock.groupMetadata(jid)

      const participants =
        metadata?.participants || []

      const mentions =
        participants
          .map(p => p.id)
          .filter(Boolean)

      if (!mentions.length) return

      const hidden =
        '\u200B'.repeat(
          mentions.length
        )

      let text =
        args?.join(' ').trim() || ''

      const context =
        message.message
          ?.extendedTextMessage
          ?.contextInfo

      const quoted =
        context?.quotedMessage

      /*
       * .tag TEXT
       */
      if (text) {
        await sock.sendMessage(
          jid,
          {
            text:
              text + hidden,
            mentions
          },
          {
            quoted: message
          }
        )

        return
      }

      /*
       * Reply + .tag
       */
      if (!quoted) return

      const quotedMessage = {
        key: {
          remoteJid:
            context?.remoteJid || jid,
          id:
            context?.stanzaId,
          participant:
            context?.participant
        },
        message: quoted
      }

      /*
       * IMAGE
       */
      if (quoted.imageMessage) {
        const buffer =
          await downloadMediaMessage(
            quotedMessage,
            'buffer',
            {}
          )

        await sock.sendMessage(
          jid,
          {
            image: buffer,
            caption: hidden,
            mentions
          },
          {
            quoted: message
          }
        )

        return
      }

      /*
       * VIDEO
       */
      if (quoted.videoMessage) {
        const buffer =
          await downloadMediaMessage(
            quotedMessage,
            'buffer',
            {}
          )

        await sock.sendMessage(
          jid,
          {
            video: buffer,
            caption: hidden,
            mentions
          },
          {
            quoted: message
          }
        )

        return
      }

      /*
       * STICKER
       */
      if (quoted.stickerMessage) {
        const buffer =
          await downloadMediaMessage(
            quotedMessage,
            'buffer',
            {}
          )

        await sock.sendMessage(
          jid,
          {
            sticker: buffer,
            mentions
          },
          {
            quoted: message
          }
        )

        return
      }

      /*
       * TEXT
       */
      const quotedText =
        quoted.conversation ||
        quoted.extendedTextMessage?.text ||
        quoted.imageMessage?.caption ||
        quoted.videoMessage?.caption ||
        quoted.documentMessage?.caption ||
        ''

      if (quotedText) {
        await sock.sendMessage(
          jid,
          {
            text:
              quotedText + hidden,
            mentions
          },
          {
            quoted: message
          }
        )
      }

    } catch (error) {
      console.error(
        '[HIDETAG ERROR]',
        error?.message || error
      )
    }
  }
}