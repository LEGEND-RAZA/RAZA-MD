import fs from 'node:fs'

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
      // 🚀 DYNAMIC IMPORTS (Prevents plugin-loader from crashing)
      const meowPkg = (await import('meowcaller-js')).default || (await import('meowcaller-js'))
      const { Client, SourceFunc } = meowPkg
      const yts = (await import('yt-search')).default
      const { createPcmStream } = await import('../lib/audioHelper.js')
      
      if (!Client) throw new Error('meowcaller-js loaded but Client is undefined')

      await sock.sendMessage(jid, { text: `🔍 Searching and downloading "${songQuery}"...` })

      // 1. Search YouTube
      const search = await yts(songQuery)
      const video = search.videos[0]
      if (!video) throw new Error('Song not found')

      // 2. Download audio to temp file
      // ⚠️ YOU MUST ADD YOUR DOWNLOAD LOGIC HERE (e.g., from your .play plugin)
      // const buffer = await downloadAudio(video.url)
      // fs.writeFileSync(tempFile, buffer)
      
      // Dummy file check for safety
      if (!fs.existsSync(tempFile)) {
         throw new Error('Audio download failed. You must implement the downloader logic inside playcall.js')
      }

      // 3. Create PCM stream
      const pcmStream = await createPcmStream(tempFile)

      // 4. Initialize MeowCaller
      const client = new Client(sock)
      client.connect()

      // 5. Start the group call
      call = await client.groupCall({ group: groupJid }) 
      
      await sock.sendMessage(jid, { text: '📞 Joining group call and streaming audio...' })

      // 6. Stream audio when ready
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
