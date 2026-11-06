import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ytDlp from 'yt-dlp-exec'
import yts from 'yt-search'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'

const execFileAsync = promisify(execFile)

const FFMPEG_PATH = ffmpegStatic || 'ffmpeg'
const FFPROBE_PATH = ffprobeStatic?.path || 'ffprobe'
const MAX_VIDEO_BYTES = 60 * 1024 * 1024
const MIN_VIDEO_BYTES = 16 * 1024
const MAX_DURATION_SEC = 20 * 60
const COOKIES_FILE = process.env.YOUTUBE_COOKIES || '' // optional path to cookies.txt

async function searchYouTube(query) {
    const res = await yts(query)
    const v = res.videos?.[0]
    if (!v) return null
    return {
        url: v.url,
        title: v.title || 'YouTube Video',
        thumbnail: v.thumbnail || '',
        author: v.author?.name || 'Unknown',
        duration: v.seconds || 0,
        views: v.views || 0,
    }
}

function fmtDuration(sec) {
    if (!sec) return 'Unknown'
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
}

async function runYtDlp(url, outputTemplate, quality, extra) {
    await ytDlp(url, {
        output: outputTemplate,
        format: `bv*[height<=${quality}][ext=mp4]+ba[ext=m4a]/b[height<=${quality}][ext=mp4]/bv*[height<=${quality}]+ba/b[height<=${quality}]/b`,
        mergeOutputFormat: 'mp4',
        noPlaylist: true,
        noWarnings: true,
        noCheckCertificates: true,
        maxFilesize: '60M',
        ffmpegLocation: FFMPEG_PATH,
        ...(COOKIES_FILE ? { cookies: COOKIES_FILE } : {}),
        ...extra,
    })
}

async function downloadWithYtDlp(url, quality = 720) {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yt-dlp-'))
    const template = path.join(tempDir, 'video.%(ext)s')

    try {
        // Different player clients work on different servers, so try several
        const attempts = [
            { jsRuntimes: 'node', extractorArgs: 'youtube:player_client=default,mweb' },
            { extractorArgs: 'youtube:player_client=android,web' },
            { extractorArgs: 'youtube:player_client=ios' },
            {},
        ]

        let lastError = null
        let file = null
        for (const extra of attempts) {
            try {
                await runYtDlp(url, template, quality, extra)
                const files = await fs.promises.readdir(tempDir)
                const found = files.find(f => f.startsWith('video.') && !f.endsWith('.part'))
                if (found) { file = path.join(tempDir, found); break }
            } catch (err) {
                lastError = err
                const msg = String(err.stderr || err.message || '')
                console.error('[Video Plugin] attempt failed:', msg.split('\n').slice(-3).join(' | '))
            }
        }

        if (!file) {
            const detail = String(lastError?.stderr || lastError?.message || 'unknown error')
                .split('\n').filter(Boolean).pop()
            throw new Error(`yt-dlp failed: ${detail}`)
        }

        const stats = await fs.promises.stat(file)
        if (stats.size < MIN_VIDEO_BYTES) throw new Error(`Downloaded file too small (${stats.size} bytes)`)
        if (stats.size > MAX_VIDEO_BYTES) throw new Error(`File too large (${(stats.size / 1048576).toFixed(1)} MB)`)

        return await ensureWhatsAppMp4(file, tempDir)
    } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
}

async function ensureWhatsAppMp4(inputPath, dir) {
    const fixedPath = path.join(dir, 'final.mp4')

    const probe = await execFileAsync(FFPROBE_PATH, [
        '-v', 'error', '-show_entries', 'stream=codec_type,codec_name',
        '-of', 'json', inputPath,
    ], { timeout: 30_000 })

    const streams = JSON.parse(probe.stdout || '{}').streams || []
    const video = streams.find(s => s.codec_type === 'video')
    const audio = streams.find(s => s.codec_type === 'audio')
    if (!video) throw new Error('file contains no video stream')

    const videoOk = /^(?:h264|avc1)$/i.test(video.codec_name || '')
    const audioOk = !audio || /^(?:aac|mp3)$/i.test(audio.codec_name || '')

    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath, '-map', '0:v:0', '-map', '0:a:0?']
    if (videoOk && audioOk) {
        args.push('-c', 'copy')
    } else {
        args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p')
        args.push(...(audio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']))
    }
    args.push('-movflags', '+faststart', fixedPath)

    await execFileAsync(FFMPEG_PATH, args, { timeout: 180_000 })
    const fixed = await fs.promises.readFile(fixedPath)
    if (fixed.length < MIN_VIDEO_BYTES) throw new Error('ffmpeg produced an invalid MP4')
    return fixed
}

export default {
    command: ['video', 'ytvideo', 'ytv'],
    category: 'downloader',

    async run(ctx) {
        const { sock, message } = ctx
        const msg = message || ctx.msg
        if (!sock || !msg) return

        const jid = msg.key?.remoteJid
        if (!jid) return

        const reply = (text) => sock.sendMessage(jid, { text }, { quoted: msg })
        const react = (emoji) => sock.sendMessage(jid, { react: { text: emoji, key: msg.key } }).catch(() => {})

        const prefix = ctx.prefix || '.'
        const command = ctx.command || 'video'
        let text = ctx.text || ''

        if (!text) {
            const full = msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                msg.message?.imageMessage?.caption ||
                msg.message?.videoMessage?.caption || ''
            text = full.replace(prefix + command, '').trim()
        }

        if (!text) return reply(`Provide video name\nExample: ${prefix}${command} Alan Walker Lily`)

        try {
            await react('🔎')
            const vid = await searchYouTube(text)
            if (!vid?.url) {
                await react('😕')
                return reply('No video found')
            }

            if (vid.duration > MAX_DURATION_SEC) {
                await react('⚠️')
                return reply(`Video is too long (${fmtDuration(vid.duration)}). Max is ${MAX_DURATION_SEC / 60} minutes.`)
            }

            const duration = fmtDuration(vid.duration)
            await react('⬇️')

            const caption = `🎬 *${vid.title}*\n\n⏱️ Duration: ${duration}\n👁️ Views: ${Number(vid.views).toLocaleString()}\n📢 Channel: ${vid.author}\n\n⏳ Downloading...`
            if (vid.thumbnail) {
                await sock.sendMessage(jid, { image: { url: vid.thumbnail }, caption }, { quoted: msg }).catch(() => {})
            } else {
                await reply(caption)
            }

            const videoBuffer = await downloadWithYtDlp(vid.url)

            await sock.sendMessage(jid, {
                video: videoBuffer,
                mimetype: 'video/mp4',
                caption: `🎬 *${vid.title}*\n⏱️ ${duration}`,
            }, { quoted: msg })

            await react('✅')
        } catch (error) {
            console.error('[Video Plugin Error]', error)
            await react('❌')
            await reply(`❌ Failed to download video.\n\n*Reason:* ${error.message}`)
        }
    }
}
