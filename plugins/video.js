import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import axios from 'axios'
import yts from 'yt-search'
import ffmpegPathStatic from 'ffmpeg-static'
import ffprobePathStatic from 'ffprobe-static'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const FFMPEG_PATH = ffmpegPathStatic || 'ffmpeg'
const FFPROBE_PATH = ffprobePathStatic.path || 'ffprobe'

const USER_AGENT = 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36'
const JSON_TIMEOUT_MS = 18_000
const DOWNLOAD_TIMEOUT_MS = 75_000
const MAX_VIDEO_BYTES = 100 * 1024 * 1024
const MIN_VIDEO_BYTES = 16 * 1024

const PIPED_APIS = (process.env.YOUTUBE_PIPED_APIS || [
    'https://pipedapi.kavin.rocks',
    'https://pipedapi-libre.kavin.rocks',
    'https://pipedapi.adminforge.de',
    'https://api.piped.yt',
    'https://pipedapi.owo.si',
    'https://pipedapi.ducks.party',
    'https://piped-api.codespace.cz',
    'https://pipedapi.reallyaweso.me',
].join(','))
    .split(',')
    .map(value => value.trim().replace(/\/$/, ''))
    .filter(Boolean)

function isHttpUrl(value) {
    return typeof value === 'string' && /^https?:\/\//i.test(value.trim())
}

function isYouTubeSourceUrl(value) {
    return /(?:youtube\.com|youtu\.be|youtube-nocookie\.com)/i.test(value)
}

function isImageOrAudioUrl(value, keyPath) {
    const lowerUrl = value.toLowerCase().split('?')[0]
    const lowerPath = keyPath.toLowerCase()
    return /(?:thumbnail|thumb|image|avatar|cover|poster|audio|music|song)/i.test(lowerPath)
        || /\.(?:jpe?g|png|webp|gif|svg|mp3|m4a|ogg|wav)(?:$|[?#])/i.test(lowerUrl)
}

function mediaQuality(label, url) {
    const match = `${label || ''} ${url || ''}`.match(/(?:^|[^0-9])(144|240|360|480|540|720|1080|1440|2160|4320)p?(?:[^0-9]|$)/i)
    return match ? Number(match[1]) : 0
}

function rankMediaCandidates(candidates) {
    const deduped = new Map()
    for (const candidate of candidates) {
        if (!isHttpUrl(candidate?.url) || isYouTubeSourceUrl(candidate.url)) continue
        const url = candidate.url.trim()
        if (!deduped.has(url)) {
            deduped.set(url, {
                url,
                label: String(candidate.label || ''),
                quality: mediaQuality(candidate.label, url),
            })
        }
    }

    return [...deduped.values()].sort((a, b) => {
        const aPreferred = a.quality > 0 && a.quality <= 720 ? 1 : 0
        const bPreferred = b.quality > 0 && b.quality <= 720 ? 1 : 0
        if (aPreferred !== bPreferred) return bPreferred - aPreferred
        if (a.quality !== b.quality) return b.quality - a.quality
        return 0
    })
}

function collectMediaUrls(payload) {
    const found = []
    const visit = (node, keyPath = [], depth = 0) => {
        if (node == null || depth > 9) return
        if (typeof node === 'string') {
            const value = node.trim()
            if (isHttpUrl(value) && !isYouTubeSourceUrl(value) && !isImageOrAudioUrl(value, keyPath.join('.'))) {
                found.push({ url: value, label: keyPath.join('.') })
            }
            return
        }
        if (Array.isArray(node)) {
            node.forEach((entry, index) => visit(entry, [...keyPath, String(index)], depth + 1))
            return
        }
        if (typeof node !== 'object') return
        for (const [key, value] of Object.entries(node)) {
            visit(value, [...keyPath, key], depth + 1)
        }
    }
    visit(payload)
    return rankMediaCandidates(found)
}

function extractYouTubeId(url) {
    if (!isHttpUrl(url)) return null
    try {
        const parsed = new URL(url)
        if (parsed.hostname === 'youtu.be') return parsed.pathname.slice(1).match(/^[A-Za-z0-9_-]{6,}/)?.[0] || null
        const queryId = parsed.searchParams.get('v')
        if (queryId) return queryId.match(/^[A-Za-z0-9_-]{6,}/)?.[0] || null
        const pathMatch = parsed.pathname.match(/\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{6,})/i)
        return pathMatch ? pathMatch[1] : null
    } catch (_) {
        return null
    }
}

async function getJson(url, options = {}) {
    const response = await axios.get(url, {
        timeout: JSON_TIMEOUT_MS,
        maxContentLength: 2 * 1024 * 1024,
        maxBodyLength: 2 * 1024 * 1024,
        headers: {
            'User-Agent': USER_AGENT,
            Accept: 'application/json, text/plain, */*',
            ...options.headers,
        },
        validateStatus: () => true,
        ...options,
    })
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status}`)
    }
    if (typeof response.data === 'string' && /^\s*</.test(response.data)) {
        throw new Error('provider returned HTML instead of JSON')
    }
    return response.data
}

async function fromOfficialHector(url) {
    const data = await getJson('https://yt-dl.officialhectormanuel.workers.dev/', { params: { url } })
    return collectMediaUrls(data)
}

async function fromDavidCyril(url) {
    const data = await getJson('https://apis.davidcyril.name.ng/download/ytmp4', { params: { url } })
    return collectMediaUrls(data)
}

async function fromEliteProTech(url) {
    const data = await getJson('https://eliteprotech-apis.zone.id/ytmp4', { params: { url } })
    return collectMediaUrls(data)
}

async function fromAgatz(url) {
    const data = await getJson('https://api.agatz.xyz/api/ytmp4', { params: { url } })
    return collectMediaUrls(data)
}

async function fromPrexzy(url) {
    const data = await getJson('https://prexzyapis.com/download/youtube-video', { params: { url } })
    return collectMediaUrls(data)
}

async function fromPiped(url) {
    const videoId = extractYouTubeId(url)
    if (!videoId) return []

    for (const api of PIPED_APIS) {
        try {
            const data = await getJson(`${api}/streams/${videoId}`, { timeout: 10_000 })
            const streams = Array.isArray(data?.videoStreams) ? data.videoStreams : []
            const candidates = streams
                .filter(stream => isHttpUrl(stream?.url))
                .filter(stream => /video\/mp4/i.test(String(stream.mimeType || '')))
                .filter(stream => stream.videoOnly !== true)
                .map(stream => ({
                    url: stream.url,
                    label: `${stream.quality || ''} ${stream.height || ''}p`,
                }))
            const ranked = rankMediaCandidates(candidates)
            if (ranked.length) return ranked
        } catch (error) {
            console.error(`[video] Piped provider ${api} failed:`, error.message)
        }
    }
    return []
}

async function resolveAndDownloadVideo(url) {
    const providers = [
        ['official-hector', fromOfficialHector],
        ['david-cyril', fromDavidCyril],
        ['piped', fromPiped],
        ['eliteprotech', fromEliteProTech],
        ['agatz', fromAgatz],
        ['prexzy', fromPrexzy],
    ]
    let lastError = null

    for (const [name, provider] of providers) {
        let candidates
        try {
            candidates = await provider(url)
        } catch (error) {
            console.error(`[video] ${name} resolver failed:`, error.message)
            continue
        }
        if (!candidates.length) {
            console.error(`[video] ${name} returned no usable MP4 URL`)
            continue
        }

        try {
            return await downloadFirstPlayable(candidates)
        } catch (error) {
            lastError = error
            console.error(`[video] ${name} candidates were not playable:`, error.message)
        }
    }

    throw lastError || new Error('No downloader returned a usable MP4')
}

function looksLikeVideo(buffer, contentType) {
    const type = String(contentType || '').toLowerCase()
    if (type.includes('text/html') || type.includes('application/json') || type.includes('audio/')) return false
    if (type.includes('video/')) return true
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false
    const mp4 = buffer.subarray(4, 8).toString('ascii') === 'ftyp'
    const webm = buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    return mp4 || webm
}

async function downloadBinary(url) {
    let lastError = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: DOWNLOAD_TIMEOUT_MS,
                maxContentLength: MAX_VIDEO_BYTES,
                maxBodyLength: MAX_VIDEO_BYTES,
                maxRedirects: 6,
                headers: {
                    'User-Agent': USER_AGENT,
                    Accept: 'video/mp4,video/*;q=0.9,application/octet-stream;q=0.8,*/*;q=0.5',
                },
                validateStatus: () => true,
            })
            const buffer = Buffer.from(response.data || '')
            if (response.status >= 200 && response.status < 300
                && buffer.length >= MIN_VIDEO_BYTES
                && buffer.length <= MAX_VIDEO_BYTES
                && looksLikeVideo(buffer, response.headers?.['content-type'])) {
                return buffer
            }
            const type = response.headers?.['content-type'] || 'unknown'
            throw new Error(`HTTP ${response.status}, ${type}, ${buffer.length} bytes`)
        } catch (error) {
            lastError = error
            if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 700))
        }
    }
    throw lastError || new Error('download failed')
}

async function validateAndRemux(buffer) {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'raza-video-'))
    const rawPath = path.join(directory, 'input.bin')
    const fixedPath = path.join(directory, 'output.mp4')
    await fs.promises.writeFile(rawPath, buffer)

    try {
        const probe = await execFileAsync(FFPROBE_PATH, [
            '-v', 'error', '-show_entries', 'stream=codec_type,codec_name',
            '-of', 'json', rawPath,
        ], { timeout: 30_000 })
        const streams = JSON.parse(probe.stdout || '{}').streams || []
        const videoStream = streams.find(stream => stream.codec_type === 'video')
        const audioStream = streams.find(stream => stream.codec_type === 'audio')
        if (!videoStream) throw new Error('file contains no video stream')

        const videoReady = /^(?:h264|avc1)$/i.test(String(videoStream.codec_name || ''))
        const audioReady = !audioStream || /^(?:aac|mp3)$/i.test(String(audioStream.codec_name || ''))
        const needsTranscode = !videoReady || !audioReady
        const ffmpegArgs = [
            '-hide_banner', '-loglevel', 'error', '-y', '-i', rawPath,
            '-map', '0:v:0', '-map', '0:a:0?',
        ]
        if (needsTranscode) {
            ffmpegArgs.push(
                '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
                '-pix_fmt', 'yuv420p',
                ...(audioStream ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
            )
        } else {
            ffmpegArgs.push('-c', 'copy')
        }
        ffmpegArgs.push('-movflags', '+faststart', fixedPath)

        try {
            await execFileAsync(FFMPEG_PATH, ffmpegArgs, { timeout: 180_000 })
            const fixed = await fs.promises.readFile(fixedPath)
            if (fixed.length >= MIN_VIDEO_BYTES && looksLikeVideo(fixed, 'video/mp4')) return fixed
            throw new Error('ffmpeg produced an empty or invalid MP4')
        } catch (error) {
            if (needsTranscode) {
                throw new Error(`unsupported video codec ${videoStream.codec_name || 'unknown'} and conversion failed: ${error.message}`)
            }
            console.error('[video] faststart remux skipped:', error.message)
            return buffer
        }
    } finally {
        await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {})
    }
}

async function downloadFirstPlayable(candidates) {
    let lastError = null
    for (const candidate of candidates) {
        try {
            const raw = await downloadBinary(candidate.url)
            const video = await validateAndRemux(raw)
            return { video, source: candidate.url }
        } catch (error) {
            lastError = error
            console.error(`[video] candidate failed (${candidate.label || candidate.url}):`, error.message)
        }
    }
    throw lastError || new Error('No playable video candidate')
}

export default {
    command: ['video', 'ytvideo', 'ytv'],
    category: 'downloader',
    description: 'Download YouTube video',

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
        if (!query) {
            return reply(`ᴘʀᴏᴠɪᴅᴇ ᴠɪᴅᴇᴏ ɴᴀᴍᴇ\n${prefix}${ctx.command} ᴀʟᴀɴ ᴡᴀʟᴋᴇʀ ʟɪʟʏ`)
        }

        try {
            await react('🔎')

            const result = await yts(query)
            const videos = Array.isArray(result?.videos) ? result.videos : []
            const vid = videos[0]
            if (!vid?.url) {
                await react('😕')
                return reply('ɴᴏ ᴠɪᴅᴇᴏ ꜰᴏᴜɴᴅ')
            }

            const title = String(vid.title || 'YouTube Video')
            const author = String(vid.author?.name || 'Unknown')
            const duration = String(vid.timestamp || 'Unknown')
            const views = Number(vid.views || 0).toLocaleString()

            await react('⬇️')
            await sock.sendMessage(jid, {
                image: { url: vid.thumbnail },
                caption:
                    `🎬 *${title}*\n\n` +
                    `⏱️ ᴅᴜʀᴀᴛɪᴏɴ: ${duration}\n` +
                    `👁️ ᴠɪᴇᴡs: ${views}\n` +
                    `📢 ᴄʜᴀɴɴᴇʟ: ${author}\n\n` +
                    `⏳ ᴅᴏᴡɴʟᴏᴀᴅɪɴɢ...`,
            }, { quoted: msg }).catch(() => {})

            const { video } = await resolveAndDownloadVideo(vid.url)
            await sock.sendMessage(jid, {
                video,
                mimetype: 'video/mp4',
                caption: `🎬 *${title}*\n⏱️ ${duration}\n\n> ʀᴀᴢᴀ-ᴍᴅ`,
            }, { quoted: msg })

            await react('✅')
        } catch (error) {
            console.error('[video command]', error.message)
            await react('❌')
            await reply('ᴛʜᴇ ᴠɪᴅᴇᴏ ᴡᴀs ꜰᴏᴜɴᴅ, ʙᴜᴛ ᴅᴏᴡɴʟᴏᴀᴅɪɴɢ ᴏʀ ᴘᴀʀsɪɴɢ ᴛʜᴇ ᴠɪᴅᴇᴏ ꜰɪʟᴇ ꜰᴀɪʟᴇᴅ. ᴘʟᴇᴀsᴇ ᴛʀʏ ᴀɢᴀɪɴ ᴏʀ ᴜsᴇ ᴀɴᴏᴛʜᴇʀ sᴇᴀʀᴄʜ ᴘʜʀᴀsᴇ.')
        }
    }
}
