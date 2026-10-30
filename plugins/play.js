/*
 * youtube.js: YouTube song + video downloader (no API key needed)
 *
 *   .play <song name or YouTube link>     -> sends the song as audio
 *   .video <name or link> [360|480|720]   -> sends the video
 *
 * Put this file in your /plugins folder. Nothing to install.
 *
 * How it works
 *   1. Link -> used directly. Name -> searched on youtube.com (first result).
 *   2. Download links come from free public services, tried in order until one
 *      works: your own endpoint (optional) -> oceansaver -> siputzx -> yt-dlp
 *      (only if yt-dlp is installed on the server).
 *   3. The file is downloaded, size-checked, then sent to the chat.
 *
 * Free public APIs change or disappear without notice. If .play stops working,
 * add another endpoint with YT_API_MP3 / YT_API_MP4 (see CONFIG) instead of
 * editing code.
 *
 * Optional environment variables
 *   YT_MAX_MB          largest file to send, default 60
 *   YT_MAX_AUDIO_MIN   longest song, default 30 minutes
 *   YT_MAX_VIDEO_MIN   longest video, default 15 minutes
 *   YT_VIDEO_QUALITY   default video quality, 360 (smaller files = faster)
 *   YT_API_MP3 / YT_API_MP4   your own endpoint, e.g.
 *                      https://example.com/ytmp3?url={url}
 *   YT_OCEAN_KEY       replace the shared oceansaver key if it ever stops working
 *   YTDLP_PATH / YTDLP_COOKIES   yt-dlp binary / cookies.txt for the yt-dlp fallback
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const execFileAsync = promisify(execFile)

const CFG = {
  maxMB: Number(process.env.YT_MAX_MB) || 60,
  maxAudioMin: Number(process.env.YT_MAX_AUDIO_MIN) || 30,
  maxVideoMin: Number(process.env.YT_MAX_VIDEO_MIN) || 15,
  videoQuality: String(process.env.YT_VIDEO_QUALITY || '360'),
  customMp3: process.env.YT_API_MP3 || '',
  customMp4: process.env.YT_API_MP4 || '',
  // shared key that the oceansaver web page itself uses; override if it stops working
  oceanKey: process.env.YT_OCEAN_KEY || '30de256ad09118bd6b60a13de631ae2cea6e5f9d',
  ytdlp: process.env.YTDLP_PATH || 'yt-dlp',
  cookies: process.env.YTDLP_COOKIES || '',
  parallel: Number(process.env.YT_PARALLEL) || 2
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const QUALITIES = ['144', '240', '360', '480', '720', '1080']

const log = (...a) => console.log('[YT]', ...a)
const sleep = ms => new Promise(r => setTimeout(r, ms))

/* ---------- small helpers ---------- */

// Only a few downloads at once so big files don't exhaust the server's memory.
let active = 0
const waiters = []

async function acquire() {
  if (active < CFG.parallel) {
    active++
    return
  }
  await new Promise(resolve => waiters.push(resolve))
}

function release() {
  const next = waiters.shift()
  if (next) next() // hand the slot straight to the next waiter
  else active--
}

class TooBigError extends Error {
  constructor(bytes) {
    super(`file is ${(bytes / 1048576).toFixed(0)} MB`)
    this.tooBig = true
  }
}

async function fetchText(url, timeoutMs, headers = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', ...headers },
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

// JSON if possible, otherwise the raw text (some APIs answer with a bare link)
async function fetchJson(url, timeoutMs) {
  const text = await fetchText(url, timeoutMs, { Accept: 'application/json, */*' })
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const IMAGE_URL = /\.(jpe?g|png|webp|gif)(\?|$)|ytimg\.com|googleusercontent\.com/i

// Finds the download link inside whatever JSON shape an API returns.
function pickUrl(data) {
  if (typeof data === 'string') {
    const t = data.trim()
    return /^https?:\/\/\S+$/i.test(t) ? t : null
  }

  const found = []
  const walk = (node, key) => {
    if (typeof node === 'string') {
      if (/^https?:\/\//i.test(node) && !IMAGE_URL.test(node)) found.push({ key: String(key).toLowerCase(), value: node })
    } else if (Array.isArray(node)) {
      node.forEach(item => walk(item, key))
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, k)
    }
  }
  walk(data, '')

  const preferred = ['download_url', 'downloadurl', 'dl', 'download', 'link', 'url', 'audio', 'video', 'mp3', 'mp4']
  for (const key of preferred) {
    const hit = found.find(f => f.key === key)
    if (hit) return hit.value
  }
  return found[0]?.value || null
}

async function downloadBuffer(url, maxBytes) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
    signal: AbortSignal.timeout(180000)
  })
  if (!res.ok) throw new Error(`download HTTP ${res.status}`)

  const type = (res.headers.get('content-type') || '').toLowerCase()
  if (type.includes('text/html') || type.includes('json')) {
    throw new Error('link returned a web page instead of a file')
  }

  const declared = Number(res.headers.get('content-length')) || 0
  if (declared > maxBytes) throw new TooBigError(declared)

  const chunks = []
  let total = 0
  for await (const chunk of res.body) {
    total += chunk.length
    if (total > maxBytes) throw new TooBigError(total)
    chunks.push(chunk)
  }

  if (total < 10 * 1024) throw new Error('downloaded file is empty')
  return { buffer: Buffer.concat(chunks, total), type }
}

function parseDuration(text) {
  if (!text) return 0
  return String(text)
    .split(':')
    .map(Number)
    .reduce((sec, part) => sec * 60 + (part || 0), 0)
}

const safeName = s => String(s || 'youtube').replace(/[\\/:*?"<>|\n\r]+/g, ' ').trim().slice(0, 80) || 'youtube'

/* ---------- finding the video ---------- */

const YT_URL =
  /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:[^\s#]*&)?v=|shorts\/|embed\/|live\/|v\/))([\w-]{11})/i

function extractVideoId(text) {
  return String(text || '').match(YT_URL)?.[1] || null
}

function* walkObjects(node) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) yield* walkObjects(item)
    return
  }
  yield node
  for (const value of Object.values(node)) yield* walkObjects(value)
}

function extractInitialData(html) {
  for (const marker of ['var ytInitialData = ', 'window["ytInitialData"] = ']) {
    const start = html.indexOf(marker)
    if (start === -1) continue
    const from = start + marker.length
    const end = html.indexOf(';</script>', from)
    if (end === -1) continue
    return JSON.parse(html.slice(from, end))
  }
  throw new Error('search page format not recognised')
}

async function searchYouTube(query) {
  const url =
    `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}` +
    '&sp=EgIQAQ%253D%253D&hl=en&gl=US'

  // the consent cookie stops the EU "before you continue" page
  const html = await fetchText(url, 12000, { Cookie: 'CONSENT=YES+1; SOCS=CAI' })
  const data = extractInitialData(html)

  for (const node of walkObjects(data)) {
    const v = node.videoRenderer
    if (!v?.videoId || !v.lengthText) continue // no lengthText = live stream, skip

    return {
      id: v.videoId,
      title:
        v.title?.runs?.map(r => r.text).join('') || v.title?.simpleText || 'YouTube video',
      channel: v.ownerText?.runs?.[0]?.text || v.longBylineText?.runs?.[0]?.text || '',
      duration: v.lengthText.simpleText || '',
      seconds: parseDuration(v.lengthText.simpleText)
    }
  }
  return null
}

async function lookupLink(id) {
  const url = `https://www.youtube.com/watch?v=${id}`
  const info = { id, title: '', channel: '', duration: '', seconds: 0 }
  try {
    const meta = await fetchJson(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
      6000
    )
    info.title = meta?.title || ''
    info.channel = meta?.author_name || ''
  } catch {
    // title is nice to have, not required
  }
  return info
}

/* ---------- download providers ---------- */

async function customApi(ctx) {
  const template = ctx.kind === 'audio' ? CFG.customMp3 : CFG.customMp4
  if (!template) throw new Error('not configured')

  const data = await fetchJson(template.replace('{url}', encodeURIComponent(ctx.videoUrl)), 30000)
  const url = pickUrl(data)
  if (!url) throw new Error('no link in response')
  return { url }
}

async function oceansaver(ctx) {
  const formats = ctx.kind === 'audio' ? ['mp3'] : [ctx.quality, 'mp4']
  let lastError

  for (const format of formats) {
    try {
      const start = await fetchJson(
        'https://p.oceansaver.in/ajax/download.php?copyright=0' +
          `&format=${format}&url=${encodeURIComponent(ctx.videoUrl)}&api=${CFG.oceanKey}`,
        20000
      )
      if (!start?.success || !start?.id) throw new Error(start?.message || 'request rejected')

      const progressUrls = [
        start.progress_url,
        `https://p.oceansaver.in/ajax/progress.php?id=${start.id}`,
        `https://p.oceansaver.in/api/progress?id=${start.id}`
      ].filter(Boolean)

      const deadline = Date.now() + 90000
      while (Date.now() < deadline) {
        await sleep(2000)

        let progress = null
        for (const u of progressUrls) {
          try {
            const data = await fetchJson(u, 15000)
            if (data && typeof data === 'object') {
              progress = data
              break
            }
          } catch {
            // try the next progress address
          }
        }
        if (!progress) continue

        if (progress.download_url) return { url: progress.download_url, title: start.title }
        if (progress.error) throw new Error(String(progress.error))
      }
      throw new Error('conversion took too long')
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

async function siputzx(ctx) {
  const paths =
    ctx.kind === 'audio'
      ? ['/api/d/ytmp3', '/api/dl/youtube/mp3']
      : ['/api/d/ytmp4', '/api/dl/youtube/mp4']

  let lastError
  for (const p of paths) {
    try {
      const data = await fetchJson(
        `https://api.siputzx.my.id${p}?url=${encodeURIComponent(ctx.videoUrl)}`,
        30000
      )
      const url = pickUrl(data)
      if (url) return { url, title: data?.data?.title }
      lastError = new Error('no link in response')
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

let ytdlpAvailable = null
let ffmpegAvailable = null

async function hasBinary(bin, arg) {
  try {
    await execFileAsync(bin, [arg], { timeout: 8000 })
    return true
  } catch {
    return false
  }
}

const MIME_BY_EXT = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  webm: 'audio/webm',
  opus: 'audio/ogg',
  mp4: 'video/mp4'
}

async function ytdlp(ctx) {
  if (ytdlpAvailable === null) ytdlpAvailable = await hasBinary(CFG.ytdlp, '--version')
  if (!ytdlpAvailable) throw new Error('yt-dlp is not installed')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-'))
  try {
    const args = [
      '--no-playlist', '--no-warnings', '--no-progress',
      '--max-filesize', `${CFG.maxMB}M`,
      '-o', path.join(dir, 'file.%(ext)s')
    ]
    if (CFG.cookies) args.push('--cookies', CFG.cookies)

    if (ctx.kind === 'audio') {
      if (ffmpegAvailable === null) ffmpegAvailable = await hasBinary('ffmpeg', '-version')
      if (ffmpegAvailable) args.push('-x', '--audio-format', 'mp3', '--audio-quality', '5')
      else args.push('-f', 'bestaudio[ext=m4a]/bestaudio')
    } else {
      args.push('-f', `best[height<=${ctx.quality}][ext=mp4]/best[height<=${ctx.quality}]/best`)
    }
    args.push(ctx.videoUrl)

    await execFileAsync(CFG.ytdlp, args, { timeout: 180000, maxBuffer: 10 * 1024 * 1024 })

    const file = fs.readdirSync(dir).find(f => f.startsWith('file.'))
    if (!file) throw new Error('yt-dlp produced no file')

    const buffer = await fs.promises.readFile(path.join(dir, file))
    const ext = path.extname(file).slice(1).toLowerCase()
    return { buffer, mimetype: MIME_BY_EXT[ext] }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function providers() {
  const list = []
  if (CFG.customMp3 || CFG.customMp4) list.push({ name: 'custom', fn: customApi })
  list.push({ name: 'oceansaver', fn: oceansaver })
  list.push({ name: 'siputzx', fn: siputzx })
  list.push({ name: 'yt-dlp', fn: ytdlp })
  return list
}

async function fetchMedia(ctx) {
  const maxBytes = CFG.maxMB * 1048576
  const failures = []

  for (const provider of providers()) {
    try {
      log(`${ctx.kind} ${ctx.id}: trying ${provider.name}`)
      const result = await provider.fn(ctx)

      const file = result.buffer
        ? { buffer: result.buffer, type: result.mimetype || '' }
        : await downloadBuffer(result.url, maxBytes)

      if (file.buffer.length > maxBytes) throw new TooBigError(file.buffer.length)
      return { ...file, title: result.title }
    } catch (error) {
      if (error.tooBig) throw error
      failures.push(`${provider.name}: ${error.message}`)
      log(`${provider.name} failed: ${error.message}`)
    }
  }

  throw new Error(failures.join(' | '))
}

/* ---------- the command ---------- */

async function handle(kind, { sock, message, quotedMessage, text, prefix, command }) {
  const jid = message.key.remoteJid
  const reply = body => sock.sendMessage(jid, { text: body }, { quoted: message })

  let query = String(text || '').trim()
  if (!query && quotedMessage) {
    query = (quotedMessage.conversation || quotedMessage.extendedTextMessage?.text || '').trim()
  }

  // optional quality at the end: ".video despacito 720"
  let quality = CFG.videoQuality
  const words = query.split(/\s+/)
  const lastWord = words[words.length - 1]?.replace(/p$/i, '')
  if (kind === 'video' && words.length > 1 && QUALITIES.includes(lastWord)) {
    quality = lastWord
    query = words.slice(0, -1).join(' ')
  }

  if (!query) {
    return reply(
      kind === 'audio'
        ? `🎵 Send a song name or link.\nExample: ${prefix}${command} shape of you`
        : `🎬 Send a video name or link.\nExample: ${prefix}${command} shape of you 480`
    )
  }

  let info
  const id = extractVideoId(query)
  try {
    info = id ? await lookupLink(id) : await searchYouTube(query)
  } catch (error) {
    log('search failed:', error.message)
    return reply('❌ YouTube search failed. Try again, or send the YouTube link directly.')
  }
  if (!info) return reply(`❌ Nothing found for "${query}".`)

  const maxMin = kind === 'audio' ? CFG.maxAudioMin : CFG.maxVideoMin
  if (info.seconds && info.seconds > maxMin * 60) {
    return reply(`❌ "${info.title}" is ${info.duration}. The limit is ${maxMin} minutes.`)
  }

  // thumbnail card goes out while the file is being fetched
  const caption =
    `${kind === 'audio' ? '🎵' : '🎬'} *${info.title || 'YouTube'}*` +
    (info.channel ? `\n👤 ${info.channel}` : '') +
    (info.duration ? `\n⏱ ${info.duration}` : '') +
    '\n\n⏳ Downloading...'

  const card = sock
    .sendMessage(
      jid,
      { image: { url: `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg` }, caption },
      { quoted: message }
    )
    .catch(() => reply(caption).catch(() => {}))

  const ctx = {
    kind,
    id: info.id,
    quality,
    videoUrl: `https://www.youtube.com/watch?v=${info.id}`
  }

  let media
  await acquire()
  try {
    media = await fetchMedia(ctx)
  } catch (error) {
    await card
    if (error.tooBig) {
      return reply(
        `❌ That file is too big for WhatsApp (${error.message}, limit ${CFG.maxMB} MB).` +
          (kind === 'video' ? ' Try a lower quality, e.g. 240.' : '')
      )
    }
    console.error('[YT] all sources failed:', error.message)
    return reply('❌ Could not download it right now (all download sources failed). Try again in a minute.')
  } finally {
    release()
  }

  await card
  const title = media.title || info.title
  const name = safeName(title)

  if (kind === 'audio') {
    const mimetype = media.type?.startsWith('audio/') ? media.type : 'audio/mpeg'
    const ext = mimetype.includes('mp4') ? 'm4a' : 'mp3'
    await sock.sendMessage(
      jid,
      { audio: media.buffer, mimetype, fileName: `${name}.${ext}` },
      { quoted: message }
    )
  } else {
    await sock.sendMessage(
      jid,
      { video: media.buffer, mimetype: 'video/mp4', fileName: `${name}.mp4`, caption: `🎬 ${title}` },
      { quoted: message }
    )
  }
}

export const playCommand = {
  command: ['play', 'song', 'ytmp3', 'yta'],
  run: ctx => handle('audio', ctx)
}

export const videoCommand = {
  command: ['video', 'ytmp4', 'ytv'],
  run: ctx => handle('video', ctx)
}

export default playCommand
