import { downloadMediaMessage } from '@whiskeysockets/baileys'
import fs from 'node:fs'
import path from 'node:path'

const CACHE_DIR = path.join(process.cwd(), 'database', 'vv_cache')

// Ensure the cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true })
}

export async function captureViewOnce(sock, message) {
  try {
    const msg = message.message
    if (!msg) return

    // Check if the message is a View Once
    const isViewOnce = msg.viewOnceMessageV2 || msg.viewOnceMessage || msg.viewOnceMessageV2Extension
    if (!isViewOnce) return

    const inner = isViewOnce.message
    const mediaType = Object.keys(inner || {})[0]

    if (!['imageMessage', 'videoMessage', 'audioMessage'].includes(mediaType)) return

    const targetMsg = {
      key: message.key,
      message: inner
    }

    // Download silently in the background
    const buffer = await downloadMediaMessage(
      targetMsg,
      'buffer',
      {},
      { logger: console, reuploadRequest: sock.updateMediaMessage }
    )

    if (buffer && buffer.length > 0) {
      const ext = mediaType.replace('Message', '')
      const cachePath = path.join(CACHE_DIR, `${message.key.id}.${ext}`)
      fs.writeFileSync(cachePath, buffer)
      console.log(`[VIEWONCE] Cached ${ext} for message ID: ${message.key.id}`)
    }
  } catch (e) {
    // Silently ignore errors so it doesn't crash the bot
  }
}

// Auto-cleanup: Delete cached files older than 24 hours
setInterval(() => {
  try {
    const files = fs.readdirSync(CACHE_DIR)
    const now = Date.now()
    for (const file of files) {
      const filePath = path.join(CACHE_DIR, file)
      const stats = fs.statSync(filePath)
      if (now - stats.mtimeMs > 24 * 60 * 60 * 1000) {
        fs.unlinkSync(filePath)
      }
    }
  } catch {}
}, 60 * 60 * 1000) // Run every hour
