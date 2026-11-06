/**
 * .tts <text> — Text-to-Speech
 * Converts text into a voice note.
 */

const AUDIO_RE = /\.(mp3|ogg|m4a|wav|aac|opus)(\?|$)/i
const URL_RE = /^https?:\/\//i

function walkAudioUrls(node, out) {
    if (!node) return
    if (typeof node === 'string') {
        if (URL_RE.test(node) && AUDIO_RE.test(node)) out.push(node)
        return
    }
    if (Array.isArray(node)) { for (const v of node) walkAudioUrls(v, out); return }
    if (typeof node === 'object') { for (const v of Object.values(node)) walkAudioUrls(v, out) }
}

// ─── Step 1: Try prexzyvilla directly (accepts raw audio or JSON) ──────
async function tryPrexzyvillaDirect(text) {
    try {
        const url = `https://prexzyapis.com/tts/tts-en?text=${encodeURIComponent(text)}`
        const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (RAZA-MD)' },
            signal: AbortSignal.timeout(30000)
        })
        if (!res.ok) return null

        const contentType = String(res.headers.get('content-type') || '')

        // Shape A: Raw audio bytes
        if (contentType.includes('audio') || contentType.includes('octet-stream') || contentType.includes('mpeg')) {
            const buffer = Buffer.from(await res.arrayBuffer())
            if (buffer && buffer.length > 1024) return { buffer, mimetype: 'audio/mpeg' }
            return null
        }

        // Shape B: JSON with a nested audio URL
        if (contentType.includes('json')) {
            const textData = await res.text()
            let parsed
            try { parsed = JSON.parse(textData) } catch { return null }
            
            const urls = []
            walkAudioUrls(parsed, urls)
            if (!urls.length) return null

            const audioRes = await fetch(urls[0], { signal: AbortSignal.timeout(30000) })
            const buffer = Buffer.from(await audioRes.arrayBuffer())
            if (buffer && buffer.length > 1024) return { buffer, mimetype: 'audio/mpeg' }
        }
        return null
    } catch (e) {
        console.error('[TTS] prexzyvilla direct failed:', e.message)
        return null
    }
}

// ─── Step 2: StreamElements (Reliable backup) ───────────────
async function tryStreamElements(text) {
    try {
        const url = `https://api.streamelements.com/kappa/v2/speech?voice=Brian&text=${encodeURIComponent(text)}`
        const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
        if (!res.ok) return null
        const buffer = Buffer.from(await res.arrayBuffer())
        if (buffer && buffer.length > 512) return { buffer, mimetype: 'audio/mpeg' }
        return null
    } catch (e) {
        console.error('[TTS] StreamElements failed:', e.message)
        return null
    }
}

// ─── Step 3: Google Translate TTS — dependable, no key needed ───────────────
async function tryGoogleTranslateTts(text) {
    try {
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=en&client=tw-ob`
        const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(20000)
        })
        if (!res.ok) return null
        const buffer = Buffer.from(await res.arrayBuffer())
        if (buffer && buffer.length > 512) return { buffer, mimetype: 'audio/mpeg' }
        return null
    } catch (e) {
        console.error('[TTS] Google Translate TTS failed:', e.message)
        return null
    }
}

// ─── MAIN COMMAND ───────────────
export default {
    command: ['tts', 'say', 'voice'],
    category: 'media',
    description: 'Convert text to speech (English)',

    async run(ctx) {
        const { sock, message } = ctx
        const msg = message || ctx.msg
        if (!sock || !msg) return

        const jid = msg.key?.remoteJid
        if (!jid) return

        const reply = (text) => sock.sendMessage(jid, { text }, { quoted: msg })
        const react = (emoji) => sock.sendMessage(jid, { react: { text: emoji, key: msg.key } }).catch(() => {})

        const prefix = ctx.prefix || '.'
        const command = ctx.command || 'tts'
        
        // Get text from ctx.text (everything after the command)
        const text = String(ctx.text || '').trim().slice(0, 600)

        if (!text) {
            return reply(
                `🗣️ *ᴛᴇxᴛ ᴛᴏ sᴘᴇᴇᴄʜ*\n\n` +
                `ᴜsᴀɢᴇ: ${prefix}${command} <ᴛᴇxᴛ>\n` +
                `ᴇxᴀᴍᴘʟᴇ: ${prefix}${command} ʜᴇʟʟᴏ ᴡᴏʀʟᴅ`
            )
        }

        try {
            await react('⏳')

            // Try all providers
            let result = await tryPrexzyvillaDirect(text)
            if (!result) result = await tryStreamElements(text)
            if (!result) result = await tryGoogleTranslateTts(text)

            if (!result || !result.buffer || result.buffer.length < 512) {
                await react('❌')
                return reply('❌ ᴛᴛs ꜰᴀɪʟᴇᴅ — ᴀʟʟ ᴘʀᴏᴠɪᴅᴇʀs ᴀʀᴇ ᴄᴜʀʀᴇɴᴛʟʏ ᴜɴᴀᴠᴀɪʟᴀʙʟᴇ. ᴛʀʏ ᴀɢᴀɪɴ sʜᴏʀᴛʟʏ.')
            }

            // Send the audio
            try {
                await sock.sendMessage(jid, {
                    audio: result.buffer,
                    mimetype: result.mimetype || 'audio/mpeg',
                    ptt: true, // ptt: true makes it a voice note (Push-To-Talk)
                }, { quoted: msg })
            } catch (e) {
                console.error('[TTS] audio send failed:', e.message)
                await react('❌')
                return reply('❌ ɢᴇɴᴇʀᴀᴛᴇᴅ ᴀᴜᴅɪᴏ ʙᴜᴛ ꜰᴀɪʟᴇᴅ ᴛᴏ sᴇɴᴅ ɪᴛ. ᴛʀʏ ᴀɢᴀɪɴ.')
            }

            await react('✅')
        } catch (err) {
            console.error('[TTS] error:', err.message)
            await react('❌')
            reply('❌ ᴛᴛs ꜰᴀɪʟᴇᴅ. ᴛʀʏ ᴀɢᴀɪɴ ʟᴀᴛᴇʀ.')
        }
    }
}
