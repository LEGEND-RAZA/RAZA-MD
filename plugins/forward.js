import { downloadMediaMessage } from '@whiskeysockets/baileys'

export default {
  command: ['forward', 'fwd'],
  description: 'Send a replied message without forwarded tag',

  async run({ sock, message, args, isOwner }) {
    const jid = message.key.remoteJid

    if (!isOwner) {
      return await sock.sendMessage(
        jid,
        {
          text: '❌ 𝐎ɴʟʏ 𝐎ᴡɴᴇʀ 𝐂ᴀɴ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ'
        },
        { quoted: message }
      )
    }

    const contextInfo =
      message.message?.extendedTextMessage?.contextInfo ||
      message.message?.imageMessage?.contextInfo ||
      message.message?.videoMessage?.contextInfo ||
      message.message?.documentMessage?.contextInfo ||
      message.message?.audioMessage?.contextInfo ||
      message.message?.stickerMessage?.contextInfo

    const quotedMessage = contextInfo?.quotedMessage

    if (!quotedMessage) {
      return await sock.sendMessage(
        jid,
        {
          text: '⚠️ 𝐑ᴇᴘʟʏ 𝐓ᴏ 𝐀 𝐌ᴇssᴀɢᴇ 𝐓ᴏ 𝐅ᴏʀᴡᴀʀᴅ'
        },
        { quoted: message }
      )
    }

    let target = args?.[0]

    if (!target) {
      return await sock.sendMessage(
        jid,
        {
          text:
            '⚠️ 𝐏ʀᴏᴠɪᴅᴇ 𝐓ʜᴇ 𝐓ᴀʀɢᴇᴛ\n\n' +
            '𝐄xᴀᴍᴘʟᴇ: *.forward 923001234567*'
        },
        { quoted: message }
      )
    }

    if (!target.includes('@')) {
      target = target.replace(/\D/g, '')

      if (!target) {
        return await sock.sendMessage(
          jid,
          { text: '❌ 𝐈ɴᴠᴀʟɪᴅ 𝐓ᴀʀɢᴇᴛ' },
          { quoted: message }
        )
      }

      target = `${target}@s.whatsapp.net`
    }

    try {
      const type = Object.keys(quotedMessage)[0]

      if (!type) {
        throw new Error('Invalid message')
      }

      const fakeQuoted = {
        key: {
          remoteJid: jid,
          fromMe: false,
          id: contextInfo.stanzaId || message.key.id,
          participant: contextInfo.participant
        },
        message: quotedMessage
      }

      let content

      switch (type) {
        case 'conversation': {
          content = {
            text: quotedMessage.conversation
          }
          break
        }

        case 'extendedTextMessage': {
          content = {
            text:
              quotedMessage.extendedTextMessage?.text || ''
          }
          break
        }

        case 'imageMessage': {
          const buffer = await downloadMediaMessage(
            fakeQuoted,
            'buffer',
            {}
          )

          content = {
            image: buffer,
            caption:
              quotedMessage.imageMessage?.caption || '',
            mimetype:
              quotedMessage.imageMessage?.mimetype
          }
          break
        }

        case 'videoMessage': {
          const buffer = await downloadMediaMessage(
            fakeQuoted,
            'buffer',
            {}
          )

          content = {
            video: buffer,
            caption:
              quotedMessage.videoMessage?.caption || '',
            mimetype:
              quotedMessage.videoMessage?.mimetype
          }
          break
        }

        case 'documentMessage': {
          const buffer = await downloadMediaMessage(
            fakeQuoted,
            'buffer',
            {}
          )

          content = {
            document: buffer,
            mimetype:
              quotedMessage.documentMessage?.mimetype ||
              'application/octet-stream',
            fileName:
              quotedMessage.documentMessage?.fileName ||
              'document',
            caption:
              quotedMessage.documentMessage?.caption || ''
          }
          break
        }

        case 'audioMessage': {
          const buffer = await downloadMediaMessage(
            fakeQuoted,
            'buffer',
            {}
          )

          content = {
            audio: buffer,
            mimetype:
              quotedMessage.audioMessage?.mimetype ||
              'audio/mp4',
            ptt:
              quotedMessage.audioMessage?.ptt || false
          }
          break
        }

        case 'stickerMessage': {
          const buffer = await downloadMediaMessage(
            fakeQuoted,
            'buffer',
            {}
          )

          content = {
            sticker: buffer
          }
          break
        }

        case 'contactMessage': {
          content = {
            contacts: {
              displayName:
                quotedMessage.contactMessage?.displayName || '',
              contacts: [
                {
                  vcard:
                    quotedMessage.contactMessage?.vcard || ''
                }
              ]
            }
          }
          break
        }

        case 'locationMessage': {
          const loc =
            quotedMessage.locationMessage

          content = {
            location: {
              degreesLatitude:
                loc?.degreesLatitude,
              degreesLongitude:
                loc?.degreesLongitude,
              name: loc?.name,
              address: loc?.address
            }
          }
          break
        }

        default:
          throw new Error(
            `Unsupported message type: ${type}`
          )
      }

      await sock.sendMessage(
        target,
        content
      )

      await sock.sendMessage(
        jid,
        {
          text: '✅ 𝐌ᴇssᴀɢᴇ 𝐒ᴇɴᴛ'
        },
        { quoted: message }
      )

    } catch (e) {
      console.error(
        '𝐅ᴏʀᴡᴀʀᴅ 𝐄ʀʀᴏʀ:',
        e?.message || e
      )

      await sock.sendMessage(
        jid,
        {
          text:
            `❌ 𝐅ᴀɪʟᴇᴅ 𝐓ᴏ 𝐒ᴇɴᴅ\n\n${e?.message || e}`
        },
        { quoted: message }
      )
    }
  }
}