import { downloadContentFromMessage } from '@whiskeysockets/baileys'

const MAX_UPLOAD_BYTES = 30 * 1024 * 1024
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/avif'])
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'video/3gpp'])

function extensionFor(mimetype, original = '') {
    const known = {
        'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
        'image/bmp': '.bmp', 'image/avif': '.avif', 'video/mp4': '.mp4', 'video/webm': '.webm',
        'video/quicktime': '.mov', 'video/x-matroska': '.mkv', 'video/3gpp': '.3gp',
    }
    return known[mimetype] || original.split('?')[0].slice(-5) || '.bin'
}

function usableType(mimetype, filename = '') {
    const type = String(mimetype || '').split(';')[0].toLowerCase()
    if (IMAGE_TYPES.has(type) || VIDEO_TYPES.has(type)) return type
    const ext = String(filename).toLowerCase()
    if (/\.(jpe?g|png|gif|webp|bmp|avif)$/.test(ext)) return 'image/jpeg'
    if (/\.(mp4|webm|mov|m4v|mkv|3gp)$/.test(ext)) return 'video/mp4'
    return null
}

async function uploadTmpfiles(buffer, filename, mimetype) {
    const form = new FormData()
    form.append('file', new Blob([buffer], { type: mimetype }), filename)
    const response = await fetch('https://tmpfiles.org/api/v1/upload', {
        method: 'POST', body: form, signal: AbortSignal.timeout(45_000),
        headers: { 'User-Agent': 'RAZA-MD/1.0' },
    })
    if (!response.ok) throw new Error(`tmpfiles.org returned HTTP ${response.status}`)
    const data = await response.json()
    const pageUrl = data?.data?.url
    if (!pageUrl) throw new Error('tmpfiles.org returned no URL')
    return pageUrl.replace('://tmpfiles.org/', '://tmpfiles.org/dl/')
}

async function uploadUguu(buffer, filename, mimetype) {
    const form = new FormData()
    form.append('files[]', new Blob([buffer], { type: mimetype }), filename)
    const response = await fetch('https://uguu.se/upload.php', {
        method: 'POST', body: form, signal: AbortSignal.timeout(45_000),
        headers: { 'User-Agent': 'RAZA-MD/1.0' },
    })
    if (!response.ok) throw new Error(`uguu.se returned HTTP ${response.status}`)
    const data = await response.json()
    const url = data?.files?.[0]?.url
    if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('uguu.se returned no URL')
    return url
}

async function uploadPublic(buffer, filename, mimetype) {
    const errors = []
    for (const uploader of [uploadTmpfiles, uploadUguu]) {
        try { return await uploader(buffer, filename, mimetype) }
        catch (error) { errors.push(error.message) }
    }
    throw new Error(errors.join(' | '))
}

export default {
    command: ['url', 'uploadurl', 'mediaurl', 'toupload'],
    category: 'media',
    description: 'Turn a replied or linked image/video into a public temporary URL',

    async run(ctx) {
        const { sock, message } = ctx
        const msg = message || ctx.msg
        if (!sock || !msg) return

        const jid = msg.key?.remoteJid
        if (!jid) return

        const reply = (text) => sock.sendMessage(jid, { text }, { quoted: msg })
        const react = (emoji) => sock.sendMessage(jid, { react: { text: emoji, key: msg.key } }).catch(() => {})

        const prefix = ctx.prefix || '.'
        const command = ctx.command || 'url'
        const textArg = String(ctx.text || '').trim()

        const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
        const quotedImage = quoted?.imageMessage
        const quotedVideo = quoted?.videoMessage
        const link = textArg.match(/https?:\/\/[^\s]+/)?.[0]

        if (!link && !quotedImage && !quotedVideo) {
            return reply(
                `🌐 *ᴍᴇᴅɪᴀ ᴜʀʟ*\n\n` +
                `ʀᴇᴘʟʏ ᴛᴏ ᴀɴ ɪᴍᴀɢᴇ ᴏʀ ᴠɪᴅᴇᴏ ᴡɪᴛʜ ${prefix}${command}.\n` +
                `ʏᴏᴜ ᴄᴀɴ ᴀʟsᴏ ᴜsᴇ ${prefix}${command} <ᴅɪʀᴇᴄᴛ ᴜʀʟ>.\n\n` +
                `_ᴛʜᴇ ʀᴇᴛᴜʀɴᴇᴅ ʟɪɴᴋ ɪs ᴘᴜʙʟɪᴄ ᴀɴᴅ ᴛᴇᴍᴘᴏʀᴀʀʏ._`
            )
        }

        try {
            await react('⏳')

            let buffer, mimetype, filename, source

            if (link) {
                // Download from direct URL
                const res = await fetch(link, { signal: AbortSignal.timeout(30000) })
                if (!res.ok) throw new Error(`HTTP ${res.status}`)
                
                mimetype = usableType(res.headers.get('content-type'), link)
                if (!mimetype) return reply('❌ ᴛʜᴇ ᴜʀʟ ᴅɪᴅ ɴᴏᴛ ʀᴇᴛᴜʀɴ ᴀ sᴜᴘᴘᴏʀᴛᴇᴅ ɪᴍᴀɢᴇ ᴏʀ ᴠɪᴅᴇᴏ.')
                
                buffer = Buffer.from(await res.arrayBuffer())
                source = link
                filename = `raza-${Date.now()}${extensionFor(mimetype, link)}`

            } else {
                // Download from quoted message
                const type = quotedImage ? 'image' : 'video'
                const mediaMsg = quotedImage || quotedVideo
                
                mimetype = usableType(mediaMsg.mimetype) || (type === 'image' ? 'image/jpeg' : 'video/mp4')
                
                const stream = await downloadContentFromMessage(mediaMsg, type)
                const chunks = []
                for await (const chunk of stream) chunks.push(chunk)
                
                buffer = Buffer.concat(chunks)
                filename = mediaMsg.fileName || `raza-${Date.now()}${extensionFor(mimetype)}`
                source = `ʀᴇᴘʟɪᴇᴅ ${type}`
            }

            if (buffer.length > MAX_UPLOAD_BYTES) {
                await react('❌')
                return reply('❌ ᴍᴇᴅɪᴀ ᴇxᴄᴇᴇᴅs ᴛʜᴇ 30 ᴍʙ ᴘᴜʙʟɪᴄ-ᴜᴘʟᴏᴀᴅ ʟɪᴍɪᴛ.')
            }

            const url = await uploadPublic(buffer, filename, mimetype)

            const resultText =
                `✅ *ᴘᴜʙʟɪᴄ ᴍᴇᴅɪᴀ ᴜʀʟ*\n\n` +
                `📁 *ᴛʏᴘᴇ:* ${mimetype}\n` +
                `⚖️ *sɪᴢᴇ:* ${(buffer.length / 1024 / 1024).toFixed(2)} ᴍʙ\n` +
                `🔗 *ᴜʀʟ:* ${url}\n\n` +
                `_ᴀɴʏᴏɴᴇ ᴡɪᴛʜ ᴛʜᴇ ʟɪɴᴋ ᴍᴀʏ ᴀᴄᴄᴇss ᴛʜᴇ ꜰɪʟᴇ ᴡʜɪʟᴇ ᴛʜᴇ ʜᴏsᴛ ᴋᴇᴇᴘs ɪᴛ._`

            // Send with native copy button
            try {
                await sock.sendMessage(jid, {
                    text: resultText,
                    footer: '📋 ᴄʟɪᴄᴋ ᴛᴏ ᴄᴏᴘʏ',
                    templateButtons: [{ index: 1, copy: url }]
                }, { quoted: msg })
            } catch (btnError) {
                // Fallback to standard text if buttons aren't supported
                console.error('[URL Plugin] Button failed, sending text:', btnError.message)
                await reply(resultText)
            }

            await react('✅')

        } catch (error) {
            console.error('[URL Plugin] Error:', error.message)
            await react('❌')
            reply(`❌ ᴘᴜʙʟɪᴄ ᴜᴘʟᴏᴀᴅ ꜰᴀɪʟᴇᴅ:\n${error.message.slice(0, 300)}`)
        }
    }
}
