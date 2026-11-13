import meowPkg from 'meowcaller-js'
import { createPcmStream } from '../lib/audioHelper.js'
import yts from 'yt-search'
import fs from 'node:fs'

const { Client, SourceFunc } = meowPkg

export default {
  command: ['playcall', 'callmusic'],
  category: 'owner',
  description: 'Play music in a group voice call',

  async run({ sock, message, args, isOwner }) {
    const jid = message.key.remoteJid
    if (!isOwner) {
      return sock.sendMessage(jid, { text: '❌ Only the owner can use this command.' })
    }

    const groupJid = args[0]
    const songQuery = args.slice(1).join(' ')

    if (!groupJid || !groupJid.endsWith('@g.us') || !songQuery) {
      return sock.sendMessage(jid, { 
        text: '⚠️ Usage: .playcall <group_jid> <song_name>\nExample: .playcall 120363xxxx@g.us Shape of You' 
      })
    }

    let call = null
    const tempFile = `./temp_audio_${Date.now()}.mp3`

    try {
      await sock.sendMessage(jid, { text: `🔍 Searching and downloading "${songQuery}"...` })

      // 1. Search YouTube
      const search = await yts(songQuery)
      const video = search.videos[0]
      if (!video) throw new Error('Song not found')

      // 2. Download audio to a temp file (using youtubei.js or your existing downloader)
      // For this example, we assume you have a working downloader function.
      // You can replace this with your existing .play logic.
      // const buffer = await downloadAudio(video.url)
      // fs.writeFileSync(tempFile, buffer)
      
      // If you don't have a downloader, you can use a direct URL for testing:
      // const audioUrl = "https://example.com/song.mp3"
      // But WhatsApp requires a file path for ffmpeg.
      
      // For now, let's assume you download it to tempFile.
      // You MUST implement the download logic here.
      
      // 3. Create PCM stream
      const pcmStream = await createPcmStream(tempFile)

      // 4. Initialize MeowCaller
      const client = new Client(sock)
      client.connect()

      // 5. Start the group call
      // Note: The exact API for group calls might be `client.groupCall(...)`
      // or `client.call({ group: groupJid })`. Check the library docs.
      call = await client.groupCall({ group: groupJid }) 
      
      await sock.sendMessage(jid, { text: '📞 Joining group call and streaming audio...' })

      // 6. Stream audio when the call is ready
      call.onReady(() => {
        const source = SourceFunc(async () => {
          return new Promise((resolve) => {
            pcmStream.once('data', (chunk) => resolve(chunk))
            pcmStream.once('end', () => resolve(null))
          })
        })
        call.play(source)
      })

      call.onEnd((reason) => {
        console.log('Call ended:', reason)
        call = null
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile)
      })

    } catch (error) {
      console.error('[PLAYCALL ERROR]', error)
      await sock.sendMessage(jid, { text: `❌ Failed to play music: ${error.message}` })
      if (call) {
        try { call.hangup() } catch {}
      }
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile)
    }
  }
}
