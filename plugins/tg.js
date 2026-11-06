import sharp from 'sharp'
import ffmpegStatic from 'ffmpeg-static'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { spawn, execSync } from 'node:child_process'

const FFMPEG = ffmpegStatic && fs.existsSync(ffmpegStatic) ? ffmpegStatic : 'ffmpeg'

// Uses the Telegram Bot Token from your Sukuna MD setup
const TG_TOKEN = process.env.TG_BOT_TOKEN || '8773919497:AAEyyZocx4HSIRGFeJnJE19XvJZjDfJ2hU4'
const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`
const TG_FILE = `https://api.telegram.org/file/bot${TG_TOKEN}`

const MAX_SEND = 60
const PACK_NAME = 'RAZA MD'
const PACK_PUBLISHER = 'LEGEND RAZA'

function tmpFile(ext) {
    return path.join(os.tmpdir(), `tgs-${crypto.randomBytes(6).toString('hex')}${ext}`)
}

function tmpDir() {
    const d = path.join(os.tmpdir(), `tgs-${crypto.randomBytes(6).toString('hex')}`)
    fs.mkdirSync(d, { recursive: true })
    return d
}

function cleanUp(...paths) {
    for (const p of paths) {
        if (!p) continue
        try {
            const st = fs.statSync(p)
            if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true })
            else fs.unlinkSync(p)
        } catch {}
    }
}

async function dl(url) {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(40000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return Buffer.from(await r.arrayBuffer())
}

async function getJson(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) })
    return await r.json()
}

async function staticToWebp(buf) {
    return sharp(buf)
        .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp({ quality: 90, lossless: false, effort: 4 })
        .toBuffer()
}

function normalizeWebpContainer(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return null
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null
    const expectedSize = buf.length - 8
    if (buf.readUInt32LE(4) === expectedSize) return buf
    const normalized = Buffer.from(buf)
    normalized.writeUInt32LE(expectedSize >>> 0, 4)
    return normalized
}

function hasAnimationChunks(buf) {
    let offset = 12
    while (offset + 8 <= buf.length) {
        const chunk = buf.toString('ascii', offset, offset + 4)
        const size = buf.readUInt32LE(offset + 4)
        if (chunk === 'ANIM' || chunk === 'ANMF') return true
        if (size > buf.length - offset - 8) return false
        offset += 8 + size + (size % 2)
    }
    return false
}

function validateAnimatedWebp(buf) {
    const out = normalizeWebpContainer(buf)
    if (!out || out.length < 1024 || !hasAnimationChunks(out)) return null
    return sharp(out, { animated: true }).metadata()
        .then(meta => meta.width && meta.height && (!meta.pages || meta.pages >= 2) ? out : null)
        .catch(() => null)
}

function runFfmpegToAnimatedWebp(args, inputBuf = null) {
    return new Promise((resolve) => {
        if (!FFMPEG) return resolve(null)
        let settled = false
        const finish = val => { if (!settled) { settled = true; resolve(val) } }
        const ff = spawn(FFMPEG, args)
        const chunks = []
        const timer = setTimeout(() => { try { ff.kill('SIGKILL') } catch {} finish(null) }, 30000)
        ff.stdout.on('data', c => chunks.push(c))
        ff.stderr.on('data', () => {})
        ff.on('error', () => { clearTimeout(timer); finish(null) })
        ff.on('close', async code => {
            clearTimeout(timer)
            if (code !== 0 || !chunks.length) return finish(null)
            const output = await validateAnimatedWebp(Buffer.concat(chunks))
            finish(output)
        })
        ff.stdin.on('error', () => {})
        if (inputBuf) ff.stdin.end(inputBuf)
        else ff.stdin.end()
    })
}

function ffmpegToAnimatedWebp(inputBuf, inputFps = 15) {
    return runFfmpegToAnimatedWebp([
        '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
        '-vf', `scale=512:512:force_original_aspect_ratio=decrease,fps=${inputFps}`,
        '-vcodec', 'libwebp_anim', '-lossless', '0', '-compression_level', '6', '-q:v', '75',
        '-loop', '0', '-preset', 'default', '-an', '-vsync', '0', '-f', 'webp', 'pipe:1',
    ], inputBuf)
}

function ffmpegFramesToAnimatedWebp(framesDir, inputFps = 30) {
    return runFfmpegToAnimatedWebp([
        '-hide_banner', '-loglevel', 'error', '-framerate', String(inputFps),
        '-i', path.join(framesDir, 'frame_%04d.png'),
        '-vf', 'scale=512:512:force_original_aspect_ratio=decrease',
        '-vcodec', 'libwebp_anim', '-lossless', '0', '-compression_level', '6', '-q:v', '75',
        '-loop', '0', '-preset', 'default', '-an', '-vsync', '0', '-f', 'webp', 'pipe:1',
    ])
}

async function makePackCover(stickerItems) {
    const staticItem = stickerItems.find(item => !item.isAnimated)
    if (staticItem) return staticToWebp(staticItem.data)

    const first = stickerItems[0]?.data
    if (!first) return null
    try {
        return await sharp(first, { animated: true, page: 0, pages: 1 }).webp({ quality: 90, lossless: false, effort: 4 }).toBuffer()
    } catch { return null }
}

async function tgsToAnimatedWebp(buf) {
    const jsonPath = tmpFile('.json')
    const framesDir = tmpDir()
    try {
        const jsonBuf = zlib.gunzipSync(buf)
        fs.writeFileSync(jsonPath, jsonBuf)
        let fps = 30
        try {
            const lottie = JSON.parse(jsonBuf.toString('utf8'))
            fps = Math.min(Math.max(lottie.fr || 30, 1), 30)
        } catch {}
        
        const pyScript = `
import sys, os
try:
    import rlottie_python as rl
    from PIL import Image
    anim = rl.LottieAnimation.from_file(sys.argv[1])
    total = anim.lottie_animation_get_totalframe()
    out = sys.argv[2]
    os.makedirs(out, exist_ok=True)
    for i in range(total):
        raw = anim.lottie_animation_render(i, width=512, height=512)
        Image.frombuffer('RGBA', (512, 512), bytes(raw), 'raw', 'BGRA').save(os.path.join(out, f'frame_{i:04d}.png'))
    print(total)
except ImportError:
    print('MISSING_RLOTTIE', file=sys.stderr)
    sys.exit(2)
except Exception as e:
    print(f'ERR:{e}', file=sys.stderr)
    sys.exit(1)
`
        const pyPath = tmpFile('.py')
        fs.writeFileSync(pyPath, pyScript)
        let frameCount = 0
        try {
            const out = execSync(`python3 "${pyPath}" "${jsonPath}" "${framesDir}"`, { timeout: 60000, encoding: 'utf8' }).trim()
            frameCount = parseInt(out, 10) || 0
        } catch (e) {
            if ((e.stderr || '').toString().includes('MISSING_RLOTTIE')) return null
            return null
        } finally { cleanUp(pyPath) }

        if (frameCount === 0) return null
        return await ffmpegFramesToAnimatedWebp(framesDir, fps)
    } catch {
        return null
    } finally {
        cleanUp(jsonPath, framesDir)
    }
}

export default {
    command: ['tgsticker', 'tgstickers', 'tg'],
    category: 'media',
    description: 'Convert a Telegram sticker pack into WhatsApp stickers',

    async run(ctx) {
        const { sock, message } = ctx
        const msg = message || ctx.msg
        if (!sock || !msg) return

        const jid = msg.key?.remoteJid
        if (!jid) return

        const reply = (text) => sock.sendMessage(jid, { text }, { quoted: msg })
        const react = (emoji) => sock.sendMessage(jid, { react: { text: emoji, key: msg.key } }).catch(() => {})

        const prefix = ctx.prefix || '.'
        const text = String(ctx.text || '').trim()

        if (!text || !text.includes('t.me/addstickers/')) {
            return reply(`❌ ᴜsᴀɢᴇ: ${prefix}ᴛɢsᴛɪᴄᴋᴇʀ ʜᴛᴛᴘs://ᴛ.ᴍᴇ/ᴀᴅᴅsᴛɪᴄᴋᴇʀs/ᴘᴀᴄᴋɴᴀᴍᴇ`)
        }

        await react('⏳')
        await reply('⏳ _ɪᴍᴘᴏʀᴛɪɴɢ ᴛʜᴇ sᴛɪᴄᴋᴇʀ ᴘᴀᴄᴋ. ᴘʟᴇᴀsᴇ ᴡᴀɪᴛ..._')

        const packName = text.split('/addstickers/')[1].split(/[/?#]/)[0]

        try {
            const data = await getJson(`${TG_API}/getStickerSet?name=${encodeURIComponent(packName)}`)
            if (!data.ok) return reply('❌ ᴄᴏᴜʟᴅ ɴᴏᴛ ꜰɪɴᴅ ᴛʜᴀᴛ sᴛɪᴄᴋᴇʀ ᴘᴀᴄᴋ. ᴄʜᴇᴄᴋ ᴛʜᴇ ʟɪɴᴋ.')

            const allStickers = data.result.stickers || []
            const total = allStickers.length
            if (!total) return reply('❌ ᴛʜɪs ᴘᴀᴄᴋ ʜᴀs ɴᴏ sᴛɪᴄᴋᴇʀs.')

            const toConvert = allStickers.slice(0, MAX_SEND)
            const capped = total > MAX_SEND
            const hasVideo = toConvert.some(s => s.is_video)
            const hasAnimated = toConvert.some(s => s.is_animated)
            const packType = hasVideo ? '🎬 ᴠɪᴅᴇᴏ' : hasAnimated ? '✨ ᴀɴɪᴍᴀᴛᴇᴅ' : '🖼️ sᴛᴀᴛɪᴄ'
            
            let failed = 0
            let skipped = 0
            let sent = 0

            for (const sticker of toConvert) {
                try {
                    const fileRes = await getJson(`${TG_API}/getFile?file_id=${encodeURIComponent(sticker.file_id)}`)
                    const filePath = fileRes.data?.result?.file_path
                    if (!filePath) { failed++; continue }
                    
                    const rawBuf = await dl(`${TG_FILE}/${filePath}`)
                    if (!rawBuf || rawBuf.length < 32) { failed++; continue }

                    let webpBuf
                    if (sticker.is_video || filePath.endsWith('.webm')) {
                        webpBuf = await ffmpegToAnimatedWebp(rawBuf)
                        if (!webpBuf) { failed++; continue }
                    } else if (sticker.is_animated || filePath.endsWith('.tgs')) {
                        webpBuf = await tgsToAnimatedWebp(rawBuf)
                        if (!webpBuf) { skipped++; continue }
                    } else {
                        webpBuf = await staticToWebp(rawBuf)
                        if (!webpBuf) { failed++; continue }
                    }
                    
                    if (webpBuf.length < 1024 || webpBuf.length > 1024 * 1024) {
                        failed++
                        continue
                    }

                    // Send each sticker sequentially
                    await sock.sendMessage(jid, { sticker: webpBuf }, { quoted: msg })
                    sent++
                    
                    // Small delay to prevent WhatsApp rate limits
                    await new Promise(r => setTimeout(r, 800))
                    
                } catch (err) {
                    console.error('[TG Sticker] conversion error:', err.message)
                    failed++
                }
            }

            if (sent === 0) {
                await react('❌')
                return reply(`❌ ɴᴏ sᴛɪᴄᴋᴇʀs ᴄᴏᴜʟᴅ ʙᴇ ᴄᴏɴᴠᴇʀᴛᴇᴅ ꜰʀᴏᴍ *${data.result.title || packName}*.`)
            }

            let summary = `✅ *${PACK_NAME}*\n\n` +
                `👤 ᴘᴜʙʟɪsʜᴇʀ: ${PACK_PUBLISHER}\n` +
                `📦 sᴏᴜʀᴄᴇ: *${data.result.title || packName}*\n` +
                `📁 ᴛʏᴘᴇ: ${packType}\n` +
                `📊 ᴘᴀᴄᴋᴇᴅ: ${sent}/${toConvert.length} sᴛɪᴄᴋᴇʀs`
            
            if (failed) summary += `\n❌ ꜰᴀɪʟᴇᴅ: ${failed}`
            if (skipped) summary += `\n⚠️ sᴋɪᴘᴘᴇᴅ ${skipped} ʟᴏᴛᴛɪᴇ (.ᴛɢs) sᴛɪᴄᴋᴇʀs`
            if (capped) summary += `\n\n_ᴘᴀᴄᴋ ʜᴀs ${total} ᴛᴏᴛᴀʟ — ʟɪᴍɪᴛ ɪs ${MAX_SEND}_`
            
            await react('✅')
            return reply(summary)

        } catch (err) {
            console.error('[TG Sticker] fatal error:', err.message)
            await react('❌')
            return reply('❌ sᴛɪᴄᴋᴇʀ-ᴘᴀᴄᴋ ɪᴍᴘᴏʀᴛ ꜰᴀɪʟᴇᴅ.')
        }
    }
}
