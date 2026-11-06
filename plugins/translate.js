/**
 * Translate Command — Translate text to any language
 * Usage: .translate <lang_code> <text>
 *        Reply to a message with .translate <lang_code>
 */

async function translateText(text, targetLang) {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    
    const result = await res.json()
    if (!result || !result[0]) throw new Error('Invalid response')
    
    const translated = result[0].map(item => item[0]).join('')
    const sourceLang = result[2] || 'auto'
    
    return { translated, sourceLang }
}

export default {
    command: ['translate', 'trt'],
    category: 'utility',
    description: 'Translate text to another language',

    async run(ctx) {
        const { sock, message } = ctx
        const msg = message || ctx.msg
        if (!sock || !msg) return

        const jid = msg.key?.remoteJid
        if (!jid) return

        const reply = (text) => sock.sendMessage(jid, { text }, { quoted: msg })
        const react = (emoji) => sock.sendMessage(jid, { react: { text: emoji, key: msg.key } }).catch(() => {})
        const prefix = ctx.prefix || '.'
        
        // Extract arguments
        const fullText = String(ctx.text || '').trim()
        const parts = fullText.split(/\s+/)
        const targetLang = parts[0]?.toLowerCase()
        
        // Check if replying to a message
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo || 
                            msg.message?.imageMessage?.contextInfo || 
                            msg.message?.videoMessage?.contextInfo
        const quotedMsg = contextInfo?.quotedMessage
        
        let textToTranslate = ''
        
        if (quotedMsg) {
            // Grab text from the replied message
            textToTranslate = quotedMsg.conversation || 
                              quotedMsg.extendedTextMessage?.text || 
                              quotedMsg.imageMessage?.caption || 
                              quotedMsg.videoMessage?.caption || ''
            
            if (!textToTranslate) {
                return reply(`❌ ᴛʜᴇ ʀᴇᴘʟɪᴇᴅ ᴍᴇssᴀɢᴇ ᴄᴏɴᴛᴀɪɴs ɴᴏ ᴛᴇxᴛ ᴛᴏ ᴛʀᴀɴsʟᴀᴛᴇ.`)
            }
        } else {
            // Fallback to normal text argument
            textToTranslate = parts.slice(1).join(' ')
        }

        // Validation
        if (!targetLang || (!textToTranslate && !quotedMsg)) {
            return reply(
                `🌐 *ᴛʀᴀɴsʟᴀᴛᴇ ᴄᴏᴍᴍᴀɴᴅ*\n\n` +
                `*ᴜsᴀɢᴇ 1:* ${prefix}${ctx.command} <ʟᴀɴɢ_ᴄᴏᴅᴇ> <ᴛᴇxᴛ>\n` +
                `*ᴜsᴀɢᴇ 2:* ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴍᴇssᴀɢᴇ ᴡɪᴛʜ ${prefix}${ctx.command} <ʟᴀɴɢ_ᴄᴏᴅᴇ>\n\n` +
                `*ᴇxᴀᴍᴘʟᴇs:*\n` +
                `• ${prefix}${ctx.command} es ʜᴇʟʟᴏ ᴡᴏʀʟᴅ\n` +
                `• (ʀᴇᴘʟʏ) ${prefix}${ctx.command} es\n\n` +
                `*ᴄᴏᴍᴍᴏɴ ᴄᴏᴅᴇs:*\n` +
                `ᴇɴ (ᴇɴɢʟɪsʜ) · ᴇs (sᴘᴀɴɪsʜ) · ꜰʀ (ꜰʀᴇɴᴄʜ) · ᴅᴇ (ɢᴇʀᴍᴀɴ)\n` +
                `ɪᴛ (ɪᴛᴀʟɪᴀɴ) · ᴘᴛ (ᴘᴏʀᴛᴜɢᴜᴇsᴇ) · ʀᴜ (ʀᴜssɪᴀɴ) · ᴊᴀ (ᴊᴀᴘᴀɴᴇsᴇ)\n` +
                `ᴋᴏ (ᴋᴏʀᴇᴀɴ) · ᴢʜ (ᴄʜɪɴᴇsᴇ) · ᴀʀ (ᴀʀᴀʙɪᴄ) · ʜɪ (ʜɪɴᴅɪ)\n` +
                `ɪᴅ (ɪɴᴅᴏɴᴇsɪᴀɴ) · ᴛʀ (ᴛᴜʀᴋɪsʜ) · ᴜʀ (ᴜʀᴅᴜ)`
            )
        }

        try {
            await react('⏳')
            
            const { translated, sourceLang } = await translateText(textToTranslate, targetLang)
            
            const response = 
                `🌐 *ᴛʀᴀɴsʟᴀᴛɪᴏɴ*\n\n` +
                `📝 *ᴏʀɪɢɪɴᴀʟ (${sourceLang}):*\n${textToTranslate}\n\n` +
                `🔤 *ᴛʀᴀɴsʟᴀᴛᴇᴅ (${targetLang}):*\n${translated}\n\n` +
                `> ʀᴀᴢᴀ-ᴍᴅ`

            await reply(response)
            await react('✅')

        } catch (err) {
            await react('❌')
            reply(`❌ ᴛʀᴀɴsʟᴀᴛɪᴏɴ ꜰᴀɪʟᴇᴅ. ᴘʟᴇᴀsᴇ ᴄʜᴇᴄᴋ ᴛʜᴇ ʟᴀɴɢᴜᴀɢᴇ ᴄᴏᴅᴇ ᴀɴᴅ ᴛʀʏ ᴀɢᴀɪɴ.`)
        }
    }
}
