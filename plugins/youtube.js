/*
 * youtube.js: YouTube downloader (youtubei.js - Modern API)
 */

import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import ffmpegPath from 'ffmpeg-static'
import { Innertube, Platform, UniversalCache } from 'youtubei.js'

/*
 * FIX 1 — "No valid URL to decipher" / "Failed to extract signature
 * decipher algorithm":
 * Current youtubei.js does NOT ship its own JavaScript interpreter. To
 * decipher stream URLs it hands YouTube's player code to
 * Platform.shim.eval, and if you never set it, deciphering always fails
 * (WEB client dies, and every retry re-parses the player = memory spike).
 * Also run: npm i youtubei.js@latest
 */
Platform.shim.eval = async data => new Function(data.output)()

const CFG = {
  maxMB: Number(process.env.YT_MAX_MB) || 60,
  maxAudioMin: Number(process.env.YT_MAX_AUDIO_MIN) || 30,
  maxVideoMin: Number(process.env.YT_MAX_VIDEO_MIN) || 15,
  videoQuality: String(process.env.YT_VIDEO_QUALITY || '360'),
  cookieString: process.env.YT_COOKIE || '',
  downloadTimeoutMs: Number(process.env.YT_DOWNLOAD_TIMEOUT_MS) || 180000
}

const QUALITIES = ['144', '240', '360', '480', '720', '1080']

// In-memory only (false) — Heroku's disk is ephemeral anyway.
const PLAYER_CACHE = new UniversalCache(false)

/*
 * Client-type fallback.
 *
 * FIX 2 — default list changed from ANDROID,WEB,IOS,TV_EMBEDDED to
 * WEB,ANDROID,TV. Your log showed IOS dying with a 404 (stale hardcoded
 * client version) and TV_EMBEDDED with a 400 — they were only burning
 * time and memory. WEB goes first because it works once the interpreter
 * shim above is in place.
 *
 * Override on Heroku with:  YT_CLIENT_TYPES="WEB,ANDROID,TV"
 */
const CLIENT_TYPES = (process.env.YT_CLIENT_TYPES || 'WEB,ANDROID,TV')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

let lastGoodSearchClient = null
let lastGoodDownloadClient = null

/*
 * FIX 3 — memory (Heroku R14/R15):
 * Before, every attempt built a brand-new Innertube session (and loaded
 * the player). Now one session per client type is created once and
 * reused, and refreshed after an hour so it can't go stale.
 * A failed create() is not kept, so the next call retries cleanly.
 */
const SESSION_TTL_MS = 60 * 60 * 1000
const sessions = new Map()

function createInnertube(clientType, { retrievePlayer = true } = {}) {
  const key = `${clientType}:${retrievePlayer}`
  const hit = sessions.get(key)
  if (hit && Date.now() - hit.at < SESSION_TTL_MS) return hit.promise

  const promise = Innertube.create({
    cookie: CFG.cookieString,
    client_type: clientType,
    cache: PLAYER_CACHE,
    retrieve_player: retrievePlayer
  }).catch(error => {
    sessions.delete(key)
    throw error
  })

  sessions.set(key, { promise, at: Date.now() })
  return promise
}

function orderedClients(preferred) {
  return preferred
    ? [preferred, ...CLIENT_TYPES.filter(c => c !== preferred)]
    : CLIENT_TYPES
}

/*
 * Runs `task(innertube)` against each client in turn, stopping at the
 * first one that doesn't throw. `task` may legitimately resolve to a
 * falsy value (e.g. "no search results") — that still counts as the
 * client working, so we don't burn through the whole list on a normal
 * "nothing found" result.
 */
async function withClientFallback(preferred, createOpts, task) {
  let lastError
  for (const clientType of orderedClients(preferred)) {
    try {
      const innertube = await createInnertube(clientType, createOpts)
      const result = await task(innertube)
      return { result, clientType }
    } catch (error) {
      lastError = error
      console.error(`[YouTube] client "${clientType}" failed:`, error?.message || error)
    }
  }
  throw lastError || new Error('All YouTube client types failed')
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

async function searchYouTube(innertube, query) {
  const search = await innertube.search(query)
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

async function lookupLink(innertube, id) {
  const info = await innertube.getInfo(id)
  return {
    id,
    title: info.basic_info.title || 'YouTube video',
    duration: info.basic_info.duration ? new Date(info.basic_info.duration * 1000).toISOString().substr(14, 5) : '',
    seconds: info.basic_info.duration || 0
  }
}

/* ---------- downloader (youtubei.js) ---------- */

/*
 * - getInfo() takes a bare video ID, never a URL.
 * - type: 'video+audio' picks a combined stream (video-only has no sound).
 * - quality strings must carry the 'p' suffix ("360p", not "360").
 * - Each client gets its own attempt, since a video can search fine on one
 *   client but fail to stream on it.
 */
async function downloadWithYoutubeI(ctx) {
  let lastError
  for (const clientType of orderedClients(lastGoodDownloadClient)) {
    try {
      const innertube = await createInnertube(clientType)
      const info = await innertube.getInfo(ctx.id)

      let media
      if (ctx.kind === 'audio') {
        const stream = await info.download({ type: 'audio', quality: 'best' })
        media = await downloadAudioAsMp3(stream, ctx.signal)
      } else {
        const wantedQuality = `${ctx.quality}p`
        const format =
          info.chooseFormat({ type: 'video+audio', quality: wantedQuality }) ||
          info.chooseFormat({ type: 'video+audio', quality: 'best' })

        if (!format) throw new Error('No combined video+audio format available for this video')

        const stream = await info.download({ format })
        media = await downloadVideo(stream, ctx.signal)
      }

      lastGoodDownloadClient = clientType
      return media
    } catch (error) {
      lastError = error
      console.error(`[YouTube] download via "${clientType}" failed:`, error?.message || error)
      // Don't burn through the rest of the list for a file-size limit or an
      // external timeout — every client will hit the same wall.
      if (error?.tooBig || ctx.signal?.aborted) throw error
    }
  }
  throw lastError || new Error('All YouTube client types failed to download')
}

/*
 * node:stream/promises `pipeline()` forwards errors and destroys both
 * ends (raw `.pipe()` left ffmpeg hanging on a mid-download error).
 * stderr is captured for real error messages, and output is size-capped.
 */
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
      // ffmpeg closing stdin early looks like an EPIPE / premature close
      // on our end — that's not a real failure.
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
    // retrievePlayer: false — this step only needs a title/duration/id,
    // never deciphering, so skip the expensive player fetch+parse here.
    const outcome = await withClientFallback(
      lastGoodSearchClient,
      { retrievePlayer: false },
      yt => (id ? lookupLink(yt, id) : searchYouTube(yt, query))
    )
    info = outcome.result
    lastGoodSearchClient = outcome.clientType
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
