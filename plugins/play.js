import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import ffmpegPath from 'ffmpeg-static'
import yts from 'yt-search'

const MAX_AUDIO_BYTES = 25 * 1024 * 1024

function safeFileName(value) {
  return String(value || 'audio').replace(/[^a-z0-9 _-]/gi, '').trim().slice(0, 100) || 'audio'
}

// 🚀 CONVERT STREAM TO MP3
async function convertToMp3(inputBuffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raza-play-'))
  const input = path.join(dir, 'input.media')
  const output = path.join(dir, 'output.mp3')
  fs.writeFileSync(input, inputBuffer, { mode: 0o600 })

  try {
    await new Promise((resolve, reject) => {
      const encoder = ffmpegPath && fs.existsSync(ffmpegPath) ? ffmpegPath : 'ffmpeg'
      const child = spawn(encoder, ['-y', '-i', input, '-vn', '-codec:a', 'libmp3lame', '-b:a', '128k', output], { stdio: ['ignore', 'ignore', 'pipe'] })
      let errorText = ''
      child.stderr.on('data', data => { errorText += data.toString().slice(-4000) })
      child.once('error', reject)
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`MP3 conversion failed (${code}): ${errorText.slice(-500)}`)))
    })
    const result = fs.readFileSync(output)
    if (!result.length || result.length > MAX_AUDIO_BYTES) throw new Error('Converted audio is too large')
    return result
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// 🚀 DOWNLOAD VIA YOUTUBEI.JS (Primary)
async function downloadWithYoutubeI(videoUrl) {
  const { Innertube } = await import('youtubei.js')
  const yt = await Innertube.create({ client_type: 'ANDROID' })
  
  const info = await yt.getInfo(videoUrl)
  const stream = await info.download({ type: 'audio', quality: 'best' })
  
  const { Readable } = await import('node:stream')
  const readable = Readable.fromWeb(stream)
  
  const chunks = []
  for await (const chunk of readable) chunks.push(chunk)
  
  const buffer = Buffer.concat(chunks)
  if (!buffer.length) throw new Error('Empty audio stream')
  
  return buffer
}

// 🚀 DOWNLOAD VIA YT-DLP (Fallback)
async function downloadWithYtDlp(videoUrl) {
  const youtubeDl = (await import('youtube-dl-exec')).default
  
  // Create a temp dir for yt-dlp output
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raza-ytdlp-'))
  const output = path.join(dir, 'audio.%(ext)s')
  
  try {
    await youtubeDl(videoUrl, {
      extractAudio: true,
      audioFormat: 'mp3',
      output: output,
      noWarnings: true,
      noCheckCertificates: true,
      preferFreeFormats: true,
    }, { timeout: 60000 })
    
    const files = fs.readdirSync(dir)
    const audioFile = files.find(f => f.endsWith('.mp3'))
    if (!audioFile) throw new Error('yt-dlp produced no mp3')
    
    const buffer = fs.readFileSync(path.join(dir, audioFile))
    if (!buffer.length || buffer.length > MAX_AUDIO_BYTES) throw new Error('File too large')
    
    return buffer
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

export default {
  command: ['play', 'song', 'music', 'audio'],
  category: 'media',
  description: 'Search YouTube and download the audio',

  async run(ctx) {
    const { sock, message } = ctx
    const msg = message || ctx.msg
    if (!sock || !msg) return

    const jid = msg.key?.remoteJid
    if (!jid) return

    const reply = (text) => sock.sendMessage(jid, { text }, { quoted: msg })
    const react = (emoji) => sock.sendMessage(jid, { react: { text: emoji, key: msg.key } }).catch(() => {})
    const prefix = ctx.prefix || '.'

    const query = String(ctx.text || '').trim()
    if (!query) return reply(`🎵 *ᴜsᴀɢᴇ:* ${prefix}${ctx.command} <sᴏɴɢ ɴᴀᴍᴇ ᴏʀ ʏᴏᴜᴛᴜʙᴇ ᴜʀʟ>\n*ᴇxᴀᴍᴘʟᴇ:* ${prefix}${ctx.command} ᴀʟꜰᴀᴀᴢ`)

    await react('🔍')
    await reply(`🔍 sᴇᴀʀᴄʜɪɴɢ ꜰᴏʀ: *${query}*...`)

    try {
      // 1. Search
      const search = await yts(query)
      const video = search.videos[0]
      if (!video) throw new Error('Song not found')

      const title = video.title || 'Audio'
      
      // 2. Send Preview
      const body = [
        `🎬 *${title}*`,
        video.author?.name ? `👤 ${video.author.name}` : '',
        video.timestamp ? `⏱️ ${video.timestamp}` : '',
        '',
        '⏳ ᴅᴏᴡɴʟᴏᴀᴅɪɴɢ ᴀᴜᴅɪᴏ...',
      ].filter(Boolean).join('\n')
      
      await sock.sendMessage(jid, { image: { url: video.thumbnail }, caption: body }, { quoted: msg }).catch(() => reply(body))

      // 3. Download (Try youtubei.js first, then yt-dlp)
      let audioBuffer = null
      try {
        console.log(`[PLAY] Downloading via youtubei.js: ${video.url}`)
        audioBuffer = await downloadWithYoutubeI(video.url)
      } catch (err) {
        console.log(`[PLAY] youtubei.js failed, falling back to yt-dlp:`, err.message)
        try {
          audioBuffer = await downloadWithYtDlp(video.url)
        } catch (err2) {
          console.error(`[PLAY] yt-dlp also failed:`, err2.message)
          throw new Error('All download methods failed')
        }
      }

      // 4. Convert to MP3
      const mp3Buffer = await convertToMp3(audioBuffer)
      const fileName = `${safeFileName(title)}.mp3`

      // 5. Send Audio
      await sock.sendMessage(jid, {
        audio: mp3Buffer,
        mimetype: 'audio/mpeg',
        fileName: fileName,
        ptt: false
      }, { quoted: msg })

      await react('✅')

    } catch (error) {
      console.error('[PLAY ERROR]:', error)
      await react('❌')
      return reply(`❌ ɪ ᴄᴏᴜʟᴅ ɴᴏᴛ ᴅᴏᴡɴʟᴏᴀᴅ ᴛʜᴀᴛ ᴀᴜᴅɪᴏ ʀɪɢʜᴛ ɴᴏᴡ.\n_${error.message}_`)
    }
  }
}
