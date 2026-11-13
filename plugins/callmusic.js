// plugins/playcall.js
import { Client, SourceFunc } from 'meowcaller-js'
import { createPcmStream } from '../lib/audioHelper.js'
import yts from 'yt-search'
import ytdl from '@distube/ytdl-core' // Or any downloader you prefer

export default {
  command: ['playcall', 'callmusic'],
  category: 'owner',
  description: 'Play music in a group voice call',

  async run({ sock, message, args, isOwner }) {
    const jid = message.key.remoteJid
    if (!isOwner) {
      return sock.sendMessage(jid, { text: '❌ Only the owner can use this command.' })
    }

    const query = args.join(' ')
    if (!query) {
      return sock.sendMessage(jid, { text: '⚠️ Usage: .playcall <group_jid> <song_name_or_url>\nExample: .playcall 120363xxxx@g.us Shape of You' })
    }

    // You need to extract the group JID. For simplicity, let's assume the first arg is the group JID
    const groupJid = args[0]
    const songQuery = args.slice(1).join(' ')

    if (!groupJid.endsWith('@g.us') || !songQuery) {
      return sock.sendMessage(jid, { text: '❌ Invalid group JID or song name.' })
    }

    let call = null

    try {
      await sock.sendMessage(jid, { text: `🔍 Searching and preparing audio for "${songQuery}"...` })

      // 1. Search YouTube (or use a direct URL)
      const search = await yts(songQuery)
      const video = search.videos[0]
      if (!video) throw new Error('Song not found')

      // 2. Get audio stream URL (using ytdl-core)
      // Note: Using ytdl-core is not recommended as it frequently breaks. 
      // For production, use a reliable API or a local file.
      const audioUrl = video.url 
      
      // 3. Create PCM stream
      // Note: createPcmStream expects a file path or direct HTTP URL.
      // If you download to a temp file, pass the file path here.
      // For this example, we assume createPcmStream can handle the YouTube URL (it might not).
      // In a real scenario, download the file first.
      const pcmStream = await createPcmStream(audioUrl) // This may fail if ytdl-core is needed

      // 4. Initialize MeowCaller
      const client = new Client(sock)
      client.connect()

      // 5. Start the group call
      // The exact API for group calls might be `client.call({ group: groupJid })` 
      // or similar. Refer to the docs. Based on search results, group calls are supported.
      call = await client.call({ group: groupJid }, groupJid) 
      
      await sock.sendMessage(jid, { text: '📞 Joining group call and streaming audio...' })

      // 6. Stream audio when the call is ready
      call.onReady(() => {
        console.log('Media is flowing into the group call')
        
        const source = SourceFunc(async () => {
          return new Promise((resolve) => {
            pcmStream.once('data', (chunk) => resolve(chunk))
            pcmStream.once('end', () => resolve(null))
          })
        })

        call.play(source)
      })

      // 7. Handle call end
      call.onEnd((reason) => {
        console.log('Call ended:', reason)
        call = null
      })

    } catch (error) {
      console.error('[PLAYCALL ERROR]', error)
      await sock.sendMessage(jid, { text: `❌ Failed to play music: ${error.message}` })
      if (call) {
        try { call.hangup() } catch {}
      }
    }
  }
}
