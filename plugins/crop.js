import { downloadMediaMessage } from '@whiskeysockets/baileys'
import sharp from 'sharp'

const delay = ms => new Promise(r => setTimeout(r, ms))

export default {
  command: ['crop', 'crop6', 'grid'],
  category: 'media',
  description: 'Crop an image into 6 perfect squares (3x2 grid) from the center',

  async run({ sock, message, quotedMessage }) {
    const jid = message.key.remoteJid

    // 1. Check for image
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
      await sock.sendMessage(jid, { text: '⏳ *ᴄʀᴏᴘᴘɪɴɢ ᴄᴇɴᴛᴇʀ ɪᴍᴀɢᴇ ɪɴᴛᴏ 6 sǫᴜᴀʀᴇs...*' }, { quoted: message })

      // 2. Download the image
      const buffer = await downloadMediaMessage(
        { message: targetMessage },
        'buffer',
        {},
        { logger: console, reuploadRequest: sock.updateMediaMessage }
      )

      // 3. Get image dimensions
      const image = sharp(buffer)
      const metadata = await image.metadata()
      const { width, height } = metadata

      if (!width || !height) throw new Error('Could not read image dimensions')

      // 4. Calculate the exact center crop box (3:2 ratio)
      // 3 columns and 2 rows means the total grid is 1.5 times wider than it is tall.
      const targetRatio = 3 / 2 

      let cropW, cropH, startX, startY

      if (width / height > targetRatio) {
        // Image is too wide (e.g., 16:9). We leave space on the LEFT and RIGHT.
        cropH = height
        cropW = Math.floor(height * targetRatio)
        startX = Math.floor((width - cropW) / 2) // Center horizontally
        startY = 0
      } else {
        // Image is too tall/square (e.g., 4x4). We leave space on the TOP and BOTTOM.
        cropW = width
        cropH = Math.floor(width / targetRatio)
        startX = 0
        startY = Math.floor((height - cropH) / 2) // Center vertically
      }

      // The size of each perfect square (width/3 or height/2)
      const squareSize = Math.floor(cropW / 3)

      // 5. Extract and send each part
      let partCount = 1
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 3; col++) {
          
          const left = startX + (col * squareSize)
          const top = startY + (row * squareSize)

          const extractedBuffer = await sharp(buffer)
            .extract({
              left: left,
              top: top,
              width: squareSize,
              height: squareSize
            })
            .jpeg({ quality: 100 })
            .toBuffer()

          await sock.sendMessage(jid, {
            image: extractedBuffer,
            caption: `📸 *ᴘᴀʀᴛ ${partCount} ᴏꜰ 6*`
          }, { quoted: message })

          partCount++
          await delay(1000) // 1 second delay to avoid WhatsApp rate limit
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
