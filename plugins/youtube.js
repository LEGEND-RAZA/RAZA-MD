/*
 * youtube.js: YouTube downloader (youtubei.js - Modern API)
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import ffmpegPath from 'ffmpeg-static'
import { Innertube } from 'youtubei.js'

const CFG = {
  maxMB: Number(process.env.YT_MAX_MB) || 60,
  maxAudioMin: Number(process.env.YT_MAX_AUDIO_MIN) || 30,
  maxVideoMin: Number(process.env.YT_MAX_VIDEO_MIN) || 15,
  videoQuality: String(process.env.YT_VIDEO_QUALITY || '360'),
  cookieString: process.env.YT_COOKIE || ''
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const QUALITIES = ['144', '240', '360', '480', '720', '1080']

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

/* ---------- finding the video ---------- */

const YT_URL = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:[^\s#]*&)?v=|shorts\/|embed\/|live\/|v\/))([\w-]{11})/i

function extractVideoId(text) {
  return String(text || '').match(YT_URL)?.[1] || null
}

async function searchYouTube(innertube, query) {
  const search = await innertube.search(query, { type: 'video' })
  const video = search.videos[0]
  if (!video) return null
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

async function downloadWithYoutubeI(ctx) {
  const innertube = await Innertube.create({
    cookie: CFG.cookieString,
    client_type: 'WEB_CREATOR' // Bypasses most bot checks
  })

  const info = await innertube.getInfo(ctx.videoUrl)

  if (ctx.kind === 'audio') {
    // Download the best audio stream
    const stream = await info.download({ type: 'audio', quality: 'best' })
    
    if (!ffmpegPath) throw new Error('ffmpeg-static not found')
    
    // Convert to MP3 on the fly using ffmpeg
    const ffmpeg = spawn(ffmpegPath, ['-i', 'pipe:0', '-vn', '-acodec', 'libmp3lame', '-f', 'mp3', 'pipe:1'])
    
    // Convert Web ReadableStream to Node stream and pipe
    const { Readable } = await import('node:stream')
    Readable.fromWeb(stream).pipe(ffmpeg.stdin)

    const chunks = []
    ffmpeg.stdout.on('data', chunk => chunks.push(chunk))
    
    await new Promise((resolve, reject) => {
      ffmpeg.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)))
      ffmpeg.on('error', reject)
    })
    return { buffer: Buffer.concat(chunks), mimetype: 'audio/mpeg' }

  } else {
    // Download video (MP4)
    const format = info.chooseFormat({ type: 'video', quality: ctx.quality, format: 'mp4' }) || 
                   info.chooseFormat({ type: 'video', quality: 'best', format: 'mp4' })
    
    if (!format) throw new Error('No video format available')

    const stream = await info.download({ format })
    
    const buffer = await new Promise((resolve, reject) => {
      const chunks = []
      let total = 0
      
      const readable = Readable.fromWeb(stream)
      
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

  // Initialize Innertube for searching/metadata
  const innertube = await Innertube.create({
    cookie: CFG.cookieString,
    client_type: 'WEB_CREATOR'
  })

  let info
  const id = extractVideoId(query)
  try {
    info = id ? await lookupLink(innertube, id) : await searchYouTube(innertube, query)
  } catch (error) {
    console.error('Search failed:', error.message)
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
    media = await downloadWithYoutubeI(ctx)
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
