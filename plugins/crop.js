import { downloadMediaMessage } from '@whiskeysockets/baileys'
import sharp from 'sharp'

const delay = ms => new Promise(r => setTimeout(r, ms))

export default {
  command: ['crop', 'crop6', 'grid'],
  category: 'media',
  description: 'Crop an image into a 3x2 grid (6 equal parts)',

  async run({ sock, message, quotedMessage }) {
    const jid = message.key.remoteJid

    // 🚀 1. Determine if replying to an image or the command itself has an image
    let targetMessage = null
    if (quotedMessage && quotedMessage.imageMessage) {
      targetMessage = quotedMessage
    } else if (message.message && message.message.imageMessage) {
      targetMessage = message.message
    }

    if (!targetMessage) {
      return sock.sendMessage(jid, { 
        text: '⚠️ *ʀᴇᴘʟʏ ᴛᴏ ᴀɴ ɪᴍᴀɢᴇ ᴡɪᴛʜ .ᴄʀᴏᴘ*' 
      }, { quoted: message })
    }

    try {
      await sock.sendMessage(jid, { react: { text: '✂️', key: message.key } })
      await sock.sendMessage(jid, { text: '⏳ *ᴄʀᴏᴘᴘɪɴɢ ɪᴍᴀɢᴇ ɪɴᴛᴏ 6 ᴘᴀʀᴛs...*' }, { quoted: message })

      // 🚀 2. Download the image
      const buffer = await downloadMediaMessage(
        { message: targetMessage },
        'buffer',
        {},
        { logger: console, reuploadRequest: sock.updateMediaMessage }
      )

      // 🚀 3. Get image dimensions
      const image = sharp(buffer)
      const metadata = await image.metadata()
      const { width, height } = metadata

      if (!width || !height) throw new Error('Could not read image dimensions')

      // 🚀 4. Calculate grid sizes (3 columns, 2 rows)
      const cols = 3
      const rows = 2
      const partWidth = Math.floor(width / cols)
      const partHeight = Math.floor(height / rows)

      // 🚀 5. Extract and send each part
      let partCount = 1
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          
          const extractedBuffer = await sharp(buffer)
            .extract({
              left: c * partWidth,
              top: r * partHeight,
              width: partWidth,
              height: partHeight
            })
            .jpeg({ quality: 100 })
            .toBuffer()

          await sock.sendMessage(jid, {
            image: extractedBuffer,
            caption: `📸 *ᴘᴀʀᴛ ${partCount} ᴏꜰ 6*`
          }, { quoted: message })

          partCount++
          // 🚀 6. Small delay to prevent WhatsApp from rate-limiting the media uploads
          await delay(800) 
        }
      }

      await sock.sendMessage(jid, { react: { text: '✅', key: message.key } })

    } catch (error) {
      console.error('[CROP ERROR]:', error)
      await sock.sendMessage(jid, { react: { text: '❌', key: message.key } })
      await sock.sendMessage(jid, { 
        text: `❌ *ꜰᴀɪʟᴇᴅ ᴛᴏ ᴄʀᴏᴘ ɪᴍᴀɢᴇ*\n\n_${error.message}_` 
      }, { quoted: message })
    }
  }
}
