/*
 * youtube.js: YouTube downloader using ytdlp-nodejs
 * Robust against SABR, PO-token, and datacenter-IP blocks.
 */

import { spawn } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import ffmpegPath from 'ffmpeg-static'
import { YtDlp } from 'ytdlp-nodejs'

const ytdlp = new YtDlp()

const CFG = {
  maxMB: Number(process.env.YT_MAX_MB) || 60,
  maxAudioMin: Number(process.env.YT_MAX_AUDIO_MIN) || 30,
  maxVideoMin: Number(process.env.YT_MAX_VIDEO_MIN) || 15,
  videoQuality: String(process.env.YT_VIDEO_QUALITY || '360'),
  // Optional: If you upload a cookies.txt file to Heroku, set the path here
  cookieFile: process.env.YT_COOKIE_FILE || null, 
  downloadTimeoutMs: Number(process.env.YT_DOWNLOAD_TIMEOUT_MS) || 180000
}

const QUALITIES = ['144', '240', '360', '480', '720', '1080']

/* ---------- helpers ---------- */

const safeName = s =>
  String(s || 'youtube').replace(/[\\/:*?"<>|\n\r]+/g, ' ').trim().slice(0, 80) || 'youtube'

function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)}s`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function extractVideoId(text) {
  const m = String(text || '').match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:[^\s#]*&)?v=|shorts\/|embed\/|live\/|v\/))([\w-]{11})/i
  )
  return m?.[1] || null
}

async function searchYouTube(query) {
  const results = await ytdlp.search(query, { maxResults: 1 })
  if (!results || results.length === 0) return null
  const v = results[0]
  return {
    id: v.id,
    title: v.title || 'YouTube Video',
    duration: v.duration_string || '',
    seconds: v.duration || 0
  }
}

async function lookupLink(id) {
  const info = await ytdlp.getInfo(`https://www.youtube.com/watch?v=${id}`)
  return {
    id,
    title: info.title || 'YouTube Video',
    duration: info.duration_string || '',
    seconds: info.duration || 0
  }
}

/* ---------- download via yt-dlp ---------- */

async function downloadAudio(url) {
  const args = { format: 'bestaudio/best' }
  if (CFG.cookieFile) args.cookies = CFG.cookieFile

  const stream = await ytdlp.stream(url, args)
  return await convertToMp3(stream)
}

async function downloadVideo(url, quality) {
  const args = { 
    format: `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]`,
    mergeOutputFormat: 'mp4'
  }
  if (CFG.cookieFile) args.cookies = CFG.cookieFile

  const stream = await ytdlp.stream(url, args)
  return await collectStream(stream)
}

/* ---------- stream processing ---------- */

async function convertToMp3(nodeStream) {
  if (!ffmpegPath) throw new Error('ffmpeg-static not found')

  const ffmpeg = spawn(ffmpegPath, [
    '-i', 'pipe:0',
    '-vn',
    '-acodec', 'libmp3lame',
    '-f', 'mp3',
    'pipe:1'
  ])

  const chunks = []
  let total = 0
  let stderrTail = ''

  ffmpeg.stdout.on('data', chunk => {
    total += chunk.length
    if (total > CFG.maxMB * 1048576) {
      try { ffmpeg.kill('SIGKILL') } catch {}
      return
    }
    chunks.push(chunk)
  })

  ffmpeg.stderr.on('data', chunk => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000)
  })

  // ytdlp-nodejs returns a Node stream, so we pipe it directly to ffmpeg
  const input = pipeline(nodeStream, ffmpeg.stdin).catch(err => {
    if (err?.code !== 'EPIPE' && err?.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw err
  })

  const exit = new Promise((resolve, reject) => {
    ffmpeg.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited with ${code}: ${stderrTail}`))
    })
    ffmpeg.on('error', reject)
  })

  await Promise.all([input, exit])
  if (total > CFG.maxMB * 1048576) throw new Error(`file exceeds ${CFG.maxMB} MB`)
  if (!chunks.length) throw new Error('ffmpeg produced no audio')

  return { buffer: Buffer.concat(chunks), mimetype: 'audio/mpeg' }
}

async function collectStream(nodeStream) {
  const chunks = []
  let total = 0

  return new Promise((resolve, reject) => {
    nodeStream.on('data', chunk => {
      total += chunk.length
      if (total > CFG.maxMB * 1048576) {
        nodeStream.destroy()
        return reject(new Error(`file exceeds ${CFG.maxMB} MB`))
      }
      chunks.push(chunk)
    })
    nodeStream.on('end', () => resolve({ buffer: Buffer.concat(chunks), mimetype: 'video/mp4' }))
    nodeStream.on('error', reject)
  })
}

/* ---------- command handler ---------- */

async function handle(kind, { sock, message, quotedMessage, text, prefix, command }) {
  const jid = message.key.remoteJid
  const reply = body => sock.sendMessage(jid, { text: body }, { quoted: message })

  let query = String(text || '').trim()
  if (!query && quotedMessage) {
    query = (quotedMessage.conversation || quotedMessage.extendedTextMessage?.text || '').trim()
  }

  let quality = CFG.videoQuality
  const words = query.split(/\s+/)
  const lastWord = words[words.length - 1]?.replace(/p$/i, '')
  if (kind === 'video' && words.length > 1 && QUALITIES.includes(lastWord)) {
    quality = lastWord
    query = words.slice(0, -1).join(' ')
  }

  if (!query) return reply(`Example: ${prefix}${command} shape of you`)

  const id = extractVideoId(query)

  let info
  try {
    info = id ? await lookupLink(id) : await searchYouTube(query)
  } catch (err) {
    console.error('Search failed:', err)
    return reply(`❌ YouTube search failed.\n\n*Reason:*\n${err.message}`)
  }
  if (!info) return reply('❌ Nothing found.')

  const maxMin = kind === 'audio' ? CFG.maxAudioMin : CFG.maxVideoMin
  if (!info.seconds) {
    return reply("❌ Can't verify this video's length (likely a livestream/premiere) — blocked.")
  }
  if (info.seconds > maxMin * 60) return reply(`❌ Limit is ${maxMin} minutes.`)

  const caption = `${kind === 'audio' ? '🎵' : '🎬'} *${info.title}*\n\n⏳ Downloading...`
  const card = sock
    .sendMessage(
      jid,
      { image: { url: `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg` }, caption },
      { quoted: message }
    )
    .catch(() => reply(caption).catch(() => {}))

  const url = `https://www.youtube.com/watch?v=${info.id}`

  let media
  try {
    media = await withTimeout(
      kind === 'audio' ? downloadAudio(url) : downloadVideo(url, quality),
      CFG.downloadTimeoutMs
    )
  } catch (err) {
    await card
    return reply(`❌ Download failed.\n\n*Reason:*\n${err.message}`)
  }

  await card
  const name = safeName(info.title)

  if (kind === 'audio') {
    await sock.sendMessage(
      jid,
      { audio: media.buffer, mimetype: 'audio/mpeg', fileName: `${name}.mp3` },
      { quoted: message }
    )
  } else {
    await sock.sendMessage(
      jid,
      {
        video: media.buffer,
        mimetype: 'video/mp4',
        fileName: `${name}.mp4`,
        caption: `🎬 ${info.title}`
      },
      { quoted: message }
    )
  }
}

export const playCommand = { command: ['play', 'song', 'ytmp3', 'yta'], run: ctx => handle('audio', ctx) }
export const videoCommand = { command: ['video', 'ytmp4', 'ytv'], run: ctx => handle('video', ctx) }
export default playCommand
