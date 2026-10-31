/*
 * youtube.js: YouTube downloader (youtubei.js v18 API)
 */

import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import ffmpegPath from 'ffmpeg-static'
import * as YTJS from 'youtubei.js'
import { Innertube, Platform, UniversalCache } from 'youtubei.js'

/*
 * youtubei.js has no built-in JavaScript interpreter; it needs this to
 * decipher stream URLs.
 */
Platform.shim.eval = async data => new Function(data.output)()

// Hide the harmless "XYZ not found" parser warnings (they spam the logs
// and cost memory). Real errors still print.
try { YTJS.Log?.setLevel?.(YTJS.Log.Level.ERROR) } catch {}

const CFG = {
  maxMB: Number(process.env.YT_MAX_MB) || 60,
  maxAudioMin: Number(process.env.YT_MAX_AUDIO_MIN) || 30,
  maxVideoMin: Number(process.env.YT_MAX_VIDEO_MIN) || 15,
  videoQuality: String(process.env.YT_VIDEO_QUALITY || '360'),
  cookieString: process.env.YT_COOKIE || '',
  downloadTimeoutMs: Number(process.env.YT_DOWNLOAD_TIMEOUT_MS) || 180000
}

const QUALITIES = ['144', '240', '360', '480', '720', '1080']

const PLAYER_CACHE = new UniversalCache(false)

/*
 * In youtubei.js v18 the "client" is chosen PER REQUEST
 * (getBasicInfo(id, { client })), not when the session is created.
 * Valid names: IOS WEB MWEB ANDROID ANDROID_VR VISIONOS YTMUSIC
 * YTMUSIC_ANDROID YTSTUDIO_ANDROID TV TV_SIMPLY TV_EMBEDDED YTKIDS
 * WEB_EMBEDDED WEB_CREATOR
 *
 * Order matters on a server: ANDROID_VR and TV don't need a PO token, so
 * they go first. Override on Heroku with YT_CLIENT_TYPES (or delete that
 * config var to use this default).
 */
const VALID_CLIENTS = new Set([
  'IOS', 'WEB', 'MWEB', 'ANDROID', 'ANDROID_VR', 'VISIONOS', 'YTMUSIC',
  'YTMUSIC_ANDROID', 'YTSTUDIO_ANDROID', 'TV', 'TV_SIMPLY', 'TV_EMBEDDED',
  'YTKIDS', 'WEB_EMBEDDED', 'WEB_CREATOR'
])

const CLIENT_TYPES = (process.env.YT_CLIENT_TYPES || 'ANDROID_VR,TV,TV_EMBEDDED,WEB_EMBEDDED,IOS,ANDROID,WEB')
  .split(',')
  .map(s => s.trim().toUpperCase())
  .filter(c => VALID_CLIENTS.has(c))

let lastGoodClient = null

function orderedClients(preferred) {
  return preferred
    ? [preferred, ...CLIENT_TYPES.filter(c => c !== preferred)]
    : CLIENT_TYPES
}

/*
 * ONE shared session (default WEB context) reused for everything, and
 * refreshed hourly. This keeps memory low: the player script is parsed
 * once instead of once per attempt.
 */
const SESSION_TTL_MS = 60 * 60 * 1000
let session = null
let sessionAt = 0

async function getSession() {
  if (session && Date.now() - sessionAt < SESSION_TTL_MS) return session

  const pending = Innertube.create({
    cache: PLAYER_CACHE,
    ...(CFG.cookieString ? { cookie: CFG.cookieString } : {})
  })
  session = pending
  sessionAt = Date.now()

  try {
    return await pending
  } catch (error) {
    if (session === pending) session = null
    throw error
  }
}

/*
 * getBasicInfo only calls the /player endpoint (getInfo also calls /next,
 * which several clients reject with 400/404), and we check playability so
 * "login required" etc. moves on to the next client.
 */
async function getPlayableInfo(yt, id, client) {
  const info = await yt.getBasicInfo(id, { client })
  const status = info.playability_status?.status
  if (status && status !== 'OK') {
    throw new Error(info.playability_status?.reason || status)
  }
  if (!info.streaming_data) throw new Error('no streaming data returned')
  return info
}

/* ---------- helpers ---------- */

let active = 0
const waiters = []

async function acquire() {
  if (active < 2) { active++; return }
  await new Promise(resolve => waiters.push(resolve))
}

function release() {
  const next = waiters.shift()
  if (next) next()
  else active--
}

class TooBigError extends Error {
  constructor(bytes) {
    super(`file is ${(bytes / 1048576).toFixed(0)} MB`)
    this.tooBig = true
  }
}

const safeName = s => String(s || 'youtube').replace(/[\\/:*?"<>|\n\r]+/g, ' ').trim().slice(0, 80) || 'youtube'

function withTimeout(promise, ms, controller) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`timed out after ${Math.round(ms / 1000)}s`))
    }, ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/* ---------- finding the video ---------- */

const YT_URL = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:[^\s#]*&)?v=|shorts\/|embed\/|live\/|v\/))([\w-]{11})/i

function extractVideoId(text) {
  return String(text || '').match(YT_URL)?.[1] || null
}

async function searchYouTube(yt, query) {
  const search = await yt.search(query)
  const videos = search.videos || []
  if (videos.length === 0) return null
  const video = videos[0]

  return {
    id: video.video_id,
    title: video.title?.toString() || 'YouTube video',
    duration: video.duration?.text || '',
    seconds: video.duration?.seconds || 0
  }
}

async function lookupLink(yt, id) {
  let lastError
  for (const client of orderedClients(lastGoodClient)) {
    try {
      const info = await getPlayableInfo(yt, id, client)
      lastGoodClient = client
      const seconds = info.basic_info?.duration || 0
      return {
        id,
        title: info.basic_info?.title || 'YouTube video',
        duration: seconds ? new Date(seconds * 1000).toISOString().substr(14, 5) : '',
        seconds
      }
    } catch (error) {
      lastError = error
      console.error(`[YouTube] lookup via "${client}" failed:`, error?.message || error)
    }
  }
  throw lastError || new Error('All YouTube clients failed')
}

/* ---------- downloader ---------- */

function pickVideoFormat(info, quality) {
  // chooseFormat THROWS when nothing matches, so try the wanted quality
  // first and then "best".
  for (const q of [`${quality}p`, 'best']) {
    try {
      return info.chooseFormat({ type: 'video+audio', quality: q })
    } catch {}
  }
  throw new Error('No combined video+audio format available for this video')
}

async function downloadWithYoutubeI(ctx) {
  const yt = await getSession()
  let lastError

  for (const client of orderedClients(lastGoodClient)) {
    try {
      const info = await getPlayableInfo(yt, ctx.id, client)

      let media
      if (ctx.kind === 'audio') {
        const stream = await info.download({ type: 'audio', quality: 'best', client })
        media = await downloadAudioAsMp3(stream, ctx.signal)
      } else {
        const format = pickVideoFormat(info, ctx.quality)
        const stream = await info.download({ format, client })
        media = await downloadVideo(stream, ctx.signal)
      }

      lastGoodClient = client
      return media
    } catch (error) {
      lastError = error
      console.error(`[YouTube] download via "${client}" failed:`, error?.message || error)
      // A size limit or an external timeout will hit every client the same.
      if (error?.tooBig || ctx.signal?.aborted) throw error
    }
  }
  throw lastError || new Error('All YouTube clients failed to download')
}

async function downloadAudioAsMp3(webStream, signal) {
  if (!ffmpegPath) throw new Error('ffmpeg-static not found')

  const ffmpeg = spawn(ffmpegPath, ['-i', 'pipe:0', '-vn', '-acodec', 'libmp3lame', '-f', 'mp3', 'pipe:1'])

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

  const onAbort = () => { try { ffmpeg.kill('SIGKILL') } catch {} }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const source = Readable.fromWeb(webStream)

    const input = pipeline(source, ffmpeg.stdin).catch(err => {
      if (err?.code !== 'EPIPE' && err?.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw err
    })

    const exit = new Promise((resolve, reject) => {
      ffmpeg.on('close', code => {
        if (code === 0) resolve()
        else reject(new Error(`ffmpeg exited with code ${code}${stderrTail ? `: ${stderrTail}` : ''}`))
      })
      ffmpeg.on('error', reject)
    })

    await Promise.all([input, exit])

    if (total > CFG.maxMB * 1048576) throw new TooBigError(total)
    if (!chunks.length) throw new Error('ffmpeg produced no audio output')

    return { buffer: Buffer.concat(chunks), mimetype: 'audio/mpeg' }
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

async function downloadVideo(webStream, signal) {
  const readable = Readable.fromWeb(webStream)
  const onAbort = () => readable.destroy(new Error('aborted'))
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const buffer = await new Promise((resolve, reject) => {
      const chunks = []
      let total = 0

      readable.on('data', chunk => {
        total += chunk.length
        if (total > CFG.maxMB * 1048576) {
          readable.destroy()
          reject(new TooBigError(total))
          return
        }
        chunks.push(chunk)
      })
      readable.on('end', () => resolve(Buffer.concat(chunks)))
      readable.on('error', reject)
    })
    return { buffer, mimetype: 'video/mp4' }
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

/* ---------- the command ---------- */

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
    const yt = await getSession()
    info = id ? await lookupLink(yt, id) : await searchYouTube(yt, query)
  } catch (error) {
    console.error('Search failed:', error)
    return reply(`❌ YouTube search failed.\n\n*Reason:*\n${error.message}`)
  }
  if (!info) return reply(`❌ Nothing found.`)

  // info.seconds is 0 for livestreams/premieres, which would silently skip
  // the duration limit, so those are blocked outright.
  const maxMin = kind === 'audio' ? CFG.maxAudioMin : CFG.maxVideoMin
  if (!info.seconds) {
    return reply(`❌ Can't verify this video's length (likely a livestream/premiere) — blocked by the duration limit.`)
  }
  if (info.seconds > maxMin * 60) return reply(`❌ Limit is ${maxMin} minutes.`)

  const caption = `${kind === 'audio' ? '🎵' : '🎬'} *${info.title}*\n\n⏳ Downloading...`
  const card = sock.sendMessage(jid, { image: { url: `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg` }, caption }, { quoted: message }).catch(() => reply(caption).catch(() => {}))

  const ctx = { kind, id: info.id, quality }

  let media
  const controller = new AbortController()
  await acquire()
  try {
    media = await withTimeout(
      downloadWithYoutubeI({ ...ctx, signal: controller.signal }),
      CFG.downloadTimeoutMs,
      controller
    )
  } catch (error) {
    await card
    return reply(`❌ Download failed.\n\n*Reason:*\n${error.message}`)
  } finally {
    release()
  }

  await card
  const name = safeName(info.title)

  if (kind === 'audio') {
    await sock.sendMessage(jid, { audio: media.buffer, mimetype: 'audio/mpeg', fileName: `${name}.mp3` }, { quoted: message })
  } else {
    await sock.sendMessage(jid, { video: media.buffer, mimetype: 'video/mp4', fileName: `${name}.mp4`, caption: `🎬 ${info.title}` }, { quoted: message })
  }
}

export const playCommand = { command: ['play', 'song', 'ytmp3', 'yta'], run: ctx => handle('audio', ctx) }
export const videoCommand = { command: ['video', 'ytmp4', 'ytv'], run: ctx => handle('video', ctx) }
export default playCommand
