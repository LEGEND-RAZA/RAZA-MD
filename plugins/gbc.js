import { downloadMediaMessage } from '@whiskeysockets/baileys'

export default {
  command: ['gbc'],
  description: 'Broadcast the replied message and tag everyone in all groups',

  async run({ sock, message, isOwner }) {
    const jid = message.key.remoteJid

    if (!isOwner) {
      return await sock.sendMessage(
        jid,
        { text: '❌ 𝐎ɴʟʏ 𝐎ᴡɴᴇʀ 𝐂ᴀɴ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ' },
        { quoted: message }
      )
    }

    const contextInfo =
      message.message?.extendedTextMessage?.contextInfo

    const quotedMessage = contextInfo?.quotedMessage

    if (!quotedMessage) {
      return await sock.sendMessage(
        jid,
        {
          text: '⚠️ 𝐑ᴇᴘʟʏ 𝐓ᴏ 𝐀 𝐌ᴇssᴀɢᴇ 𝐓ᴏ 𝐁ʀᴏᴀᴅᴄᴀsᴛ 𝐈ᴛ'
        },
        { quoted: message }
      )
    }

    try {
      const groupsMap = await sock.groupFetchAllParticipating()
      const groups = Object.values(groupsMap)

      if (!groups.length) {
        return await sock.sendMessage(
          jid,
          { text: '𝐍ᴏ 𝐆ʀᴏᴜᴘs 𝐅ᴏᴜɴᴅ.' },
          { quoted: message }
        )
      }

      await sock.sendMessage(
        jid,
        {
          text: `📢 𝐏ʀᴏᴄᴇssɪɴɢ 𝐓ᴏ ${groups.length} 𝐆ʀᴏᴜᴘs...`
        },
        { quoted: message }
      )

      const quoted = {
        key: {
          remoteJid: message.key.remoteJid,
          fromMe: false,
          id: contextInfo.stanzaId,
          participant: contextInfo.participant
        },
        message: quotedMessage
      }

      const type = Object.keys(quotedMessage)[0]

      let count = 0

      for (const group of groups) {
        try {
          const members = (group.participants || [])
            .map(p => p.id)
            .filter(Boolean)

          if (!members.length) continue

          let content

          switch (type) {
            case 'conversation': {
              content = {
                text: quotedMessage.conversation,
                mentions: members
              }
              break
            }

            case 'extendedTextMessage': {
              content = {
                text: quotedMessage.extendedTextMessage?.text || '',
                mentions: members
              }
              break
            }

            case 'imageMessage': {
              const buffer = await downloadMediaMessage(
                quoted,
                'buffer',
                {}
              )

              content = {
                image: buffer,
                caption: quotedMessage.imageMessage?.caption || '',
                mentions: members
              }
              break
            }

            case 'videoMessage': {
              const buffer = await downloadMediaMessage(
                quoted,
                'buffer',
                {}
              )

              content = {
                video: buffer,
                caption: quotedMessage.videoMessage?.caption || '',
                mentions: members
              }
              break
            }

            case 'documentMessage': {
              const buffer = await downloadMediaMessage(
                quoted,
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
                  quotedMessage.documentMessage?.caption || '',
                mentions: members
              }
              break
            }

            case 'audioMessage': {
              const buffer = await downloadMediaMessage(
                quoted,
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
                quoted,
                'buffer',
                {}
              )

              content = {
                sticker: buffer
              }
              break
            }

            default: {
              throw new Error(
                `Unsupported message type: ${type}`
              )
            }
          }

          await sock.sendMessage(
            group.id,
            content
          )

          count++

          await new Promise(resolve =>
            setTimeout(resolve, 1000)
          )

        } catch (e) {
          console.error(
            `𝐅ᴀɪʟᴇᴅ 𝐓ᴏ 𝐒ᴇɴᴅ ${group.id}:`,
            e?.message || e
          )
        }
      }

      await sock.sendMessage(
        jid,
        {
          text:
            `✅ 𝐃ᴏɴᴇ ! 𝐒ᴇɴᴛ 𝐓ᴏ *${count}/${groups.length}* 𝐆ʀᴏᴜᴘs.`
        },
        { quoted: message }
      )

    } catch (e) {
      console.error('𝐆𝐁𝐂 𝐄ʀʀᴏʀ:', e)

      await sock.sendMessage(
        jid,
        {
          text:
            `❌ 𝐅ᴀɪʟᴇᴅ 𝐓ᴏ 𝐁ᴏᴀʀᴅᴄᴀsᴛ: ${e?.message || e}`
        },
        { quoted: message }
      )
    }
  }
}