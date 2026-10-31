/*
 * youtube.js: YouTube downloader (Cookie Only with IOS Bypass)
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import ffmpegPath from 'ffmpeg-static'
import ytdl from '@distube/ytdl-core'

const CFG = {
  maxMB: Number(process.env.YT_MAX_MB) || 60,
  maxAudioMin: Number(process.env.YT_MAX_AUDIO_MIN) || 30,
  maxVideoMin: Number(process.env.YT_MAX_VIDEO_MIN) || 15,
  videoQuality: String(process.env.YT_VIDEO_QUALITY || '360'),
  cookieString: process.env.YT_COOKIE || ''
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const QUALITIES = ['144', '240', '360', '480', '720', '1080']

const log = (...a) => console.log('[YT]', ...a)

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

async function fetchText(url, timeoutMs, headers = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', ...headers },
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

async function fetchJson(url, timeoutMs) {
  const text = await fetchText(url, timeoutMs, { Accept: 'application/json, */*' })
  try { return JSON.parse(text) } catch { return text }
}

function parseDuration(text) {
  if (!text) return 0
  return String(text).split(':').map(Number).reduce((sec, part) => sec * 60 + (part || 0), 0)
}

const safeName = s => String(s || 'youtube').replace(/[\\/:*?"<>|\n\r]+/g, ' ').trim().slice(0, 80) || 'youtube'

/* ---------- finding the video ---------- */

const YT_URL = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:[^\s#]*&)?v=|shorts\/|embed\/|live\/|v\/))([\w-]{11})/i

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
  for (const marker of ['var ytInitialData = ', 'window["ytInitialData"] = ', 'window.ytInitialData = ']) {
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
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%253D%253D&hl=en&gl=US`
  const html = await fetchText(url, 12000, { Cookie: 'CONSENT=YES+1; SOCS=CAI' })
  const data = extractInitialData(html)
  for (const node of walkObjects(data)) {
    const v = node.videoRenderer
    if (!v?.videoId || !v.lengthText) continue
    return {
      id: v.videoId,
      title: v.title?.runs?.map(r => r.text).join('') || v.title?.simpleText || 'YouTube video',
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
    const meta = await fetchJson(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, 6000)
    info.title = meta?.title || ''
    info.channel = meta?.author_name || ''
    const html = await fetchText(url, 8000, { Cookie: 'CONSENT=YES+1; SOCS=CAI' })
    const match = html.match(/"lengthSeconds":"(\d+)"/)
    if (match) {
      info.seconds = parseInt(match[1], 10)
      const h = Math.floor(info.seconds / 3600)
      const m = Math.floor((info.seconds % 3600) / 60)
      const s = info.seconds % 60
      info.duration = `${h > 0 ? h + ':' : ''}${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
    }
  } catch {}
  return info
}

/* ---------- downloader (Cookie Only) ---------- */

async function downloadWithCookie(ctx) {
  if (!CFG.cookieString) {
    throw new Error('Missing YT_COOKIE. Please add it to your Environment Variables.')
  }

  // 1. Create the bypass agent directly from the string
  const agent = ytdl.createAgent(CFG.cookieString)

  try {
    // 2. Fetch video info using the agent AND force IOS/ANDROID clients
    // IOS/ANDROID clients bypass the new SABR DRM streams that cause "No playable formats"
    const info = await ytdl.getInfo(ctx.videoUrl, { 
      agent,
      playerClients: ['IOS', 'ANDROID'] 
    })

    if (!info.formats || info.formats.length === 0) {
      throw new Error('No formats returned by YouTube. The cookie might be expired.')
    }

    if (ctx.kind === 'audio') {
      const format = ytdl.chooseFormat(info.formats, { quality: 'highestaudio' })
      if (!format) throw new Error('No audio format available')
      
      const audioStream = ytdl.downloadFromInfo(info, { format, agent })
      if (!ffmpegPath) throw new Error('ffmpeg-static not found')
      
      // Convert to MP3 on the fly
      const ffmpeg = spawn(ffmpegPath, ['-i', 'pipe:0', '-vn', '-acodec', 'libmp3lame', '-f', 'mp3', 'pipe:1'])
      audioStream.pipe(ffmpeg.stdin)

      const chunks = []
      ffmpeg.stdout.on('data', chunk => chunks.push(chunk))
      
      await new Promise((resolve, reject) => {
        ffmpeg.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)))
        ffmpeg.on('error', reject)
        audioStream.on('error', reject)
      })
      return { buffer: Buffer.concat(chunks), mimetype: 'audio/mpeg' }
    } else {
      const format = ytdl.chooseFormat(info.formats, { quality: `highestvideo[height<=${ctx.quality}]` }) || ytdl.chooseFormat(info.formats, { quality: 'highest' })
      if (!format) throw new Error('No video format available')
      
      const buffer = await new Promise((resolve, reject) => {
        const chunks = []
        const stream = ytdl.downloadFromInfo(info, { format, agent })
        let total = 0
        stream.on('data', chunk => {
          total += chunk.length
          if (total > CFG.maxMB * 1048576) { stream.destroy(); reject(new TooBigError(total)); return }
          chunks.push(chunk)
        })
        stream.on('end', () => resolve(Buffer.concat(chunks)))
        stream.on('error', reject)
      })
      return { buffer, mimetype: 'video/mp4' }
    }
  } catch (e) {
    if (e.message.includes('Sign in to confirm')) {
      throw new Error('Cookie is invalid or expired. Please update YT_COOKIE.')
    }
    throw new Error(e.message)
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

  let info
  const id = extractVideoId(query)
  try {
    info = id ? await lookupLink(id) : await searchYouTube(query)
  } catch (error) {
    return reply('❌ YouTube search failed.')
  }
  if (!info) return reply(`❌ Nothing found.`)

  const maxMin = kind === 'audio' ? CFG.maxAudioMin : CFG.maxVideoMin
  if (info.seconds && info.seconds > maxMin * 60) return reply(`❌ Limit is ${maxMin} minutes.`)

  const caption = `${kind === 'audio' ? '🎵' : '🎬'} *${info.title}*\n\n⏳ Downloading...`
  const card = sock.sendMessage(jid, { image: { url: `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg` }, caption }, { quoted: message }).catch(() => reply(caption).catch(() => {}))

  const ctx = { kind, id: info.id, quality, videoUrl: `https://www.youtube.com/watch?v=${info.id}` }

  let media
  await acquire()
  try {
    media = await downloadWithCookie(ctx)
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
