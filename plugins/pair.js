// plugins/pair.js — RAZA MD pair + auto-deploy (PUBLIC)
// Usage: .pair 923001234567   OR   .pair RAZA_<session>

import crypto from 'node:crypto'

const PAIR_SERVER = (process.env.PAIR_SERVER_URL || 'https://pair-web-3e08f4e68faf.herokuapp.com').replace(/\/$/, '')

const PAIR_TIMEOUT   = 5 * 60 * 1000
const DEPLOY_TIMEOUT = 12 * 60 * 1000
const PAIR_POLL      = 2000
const DEPLOY_POLL    = 3000
const USER_COOLDOWN_MS = 3 * 60 * 1000

const cooldowns = new Map()
const sleep = ms => new Promise(r => setTimeout(r, ms))
const phoneValid   = n => /^\d{7,15}$/.test(n)
const sessionValid = s => /^RAZA_[A-Za-z0-9_-]{10,100}$/.test(s)

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, options)
  const data = await res.json().catch(() => ({}))
  return { res, data }
}

const randomAppName = () => `raza-${crypto.randomBytes(4).toString('hex')}`

// Pairing message body in Small Caps
const pairingMessage = code => (
  '🤖 *ʀᴀᴢᴀ ᴍᴅ*\n\n' +
  '🔐 *ᴘᴀɪʀ ᴄᴏᴅᴇ*\n' +
  '*' + code + '*\n\n' +
  '👤 *ᴏᴡɴᴇʀ:* ʟᴇɢᴇɴᴅ ʀᴀᴢᴀ'
)

async function pairNumber(number, onCode) {
  const { res, data } = await fetchJSON(`${PAIR_SERVER}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ number, deploy: false })
  })

  if (!res.ok || data.success === false) {
    throw new Error(data.error || `Pair server error (HTTP ${res.status})`)
  }

  const jobId = data.id
  if (!jobId) throw new Error('Pair server returned no job ID')

  let lastCode = data.code || ''
  let codeSent = false
  const startedAt = Date.now()

  if (lastCode) {
    codeSent = true
    await onCode(lastCode)
  }

  while (Date.now() - startedAt < PAIR_TIMEOUT) {
    await sleep(PAIR_POLL)

    let st
    try {
      const r = await fetchJSON(`${PAIR_SERVER}/api/status/${jobId}`, { cache: 'no-store' })
      if (!r.res.ok) {
        if (r.res.status === 404) throw new Error('Pair job expired — retry')
        continue
      }
      st = r.data
    } catch (e) {
      if (e.message.includes('expired')) throw e
      continue
    }

    if (st.error) throw new Error(st.error)

    if (st.code && st.code !== lastCode && !codeSent) {
      lastCode = st.code
      codeSent = true
      await onCode(st.code)
    }

    if (st.status === 'ready' && st.session) return st.session
    if (st.status === 'error') throw new Error(st.error || 'Pairing failed')
  }

  throw new Error('Pairing timed out — no code entered')
}

async function deployBot(appName, sessionId) {
  const { res, data } = await fetchJSON(`${PAIR_SERVER}/api/deploy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appName, sessionId })
  })

  if (!res.ok || data.success === false) {
    throw new Error(data.error || `Deploy error (HTTP ${res.status})`)
  }

  const jobId = data.id
  if (!jobId) throw new Error('Deploy server returned no job ID')

  const startedAt = Date.now()

  while (Date.now() - startedAt < DEPLOY_TIMEOUT) {
    await sleep(DEPLOY_POLL)

    let st
    try {
      const r = await fetchJSON(`${PAIR_SERVER}/api/deploy/${jobId}`, { cache: 'no-store' })
      if (!r.res.ok) {
        if (r.res.status === 404) throw new Error('Deploy job not found')
        continue
      }
      st = r.data
    } catch (e) {
      if (e.message.includes('not found')) throw e
      continue
    }

    if (st.status === 'live') return { appName, jobId }
    if (st.status === 'failed') throw new Error(st.error || 'Deployment failed')
  }

  throw new Error('Deploy timed out — check Heroku dashboard')
}

export default {
  command: ['pair'],
  category: 'general',
  description: 'Pair WhatsApp and auto-deploy RAZA-MD',

  async run({ sock, message, args }) {
    const jid = message?.key?.remoteJid
    if (!jid) return

    const target = (args?.[0] || '').trim()
    if (!phoneValid(target) && !sessionValid(target)) return

    const now = Date.now()
    if (now - (cooldowns.get(jid) || 0) < USER_COOLDOWN_MS) return
    cooldowns.set(jid, now)

    let statusMsg = null
    
    // We now edit the status message, because the code message has a button
    // and WhatsApp does NOT allow editing messages with native buttons.
    const editStatus = async text => {
      if (!statusMsg) return
      try { await sock.sendMessage(jid, { text, edit: statusMsg.key }) }
      catch (e) { console.error('[PAIR] edit failed:', e?.message || e) }
    }

    try {
      let sessionId = ''
      let wasPaired = false

      if (phoneValid(target)) {
        sessionId = await pairNumber(target, async code => {
          // 1. Send the code with the native "Click To Copy" button
          await sock.sendMessage(jid, {
            text: pairingMessage(code),
            footer: '📋 ᴄʟɪᴄᴋ ᴛᴏ ᴄᴏᴘʏ',
            templateButtons: [
              { index: 1, copy: code }
            ]
          }, { quoted: message })

          // 2. Send a separate tiny status message that we CAN edit later
          statusMsg = await sock.sendMessage(jid, { text: '⏳ ᴡᴀɪᴛɪɴɢ ꜰᴏʀ ʏᴏᴜ ᴛᴏ ᴇɴᴛᴇʀ ᴛʜᴇ ᴄᴏᴅᴇ...' })
        })
        
        wasPaired = true
        await editStatus('✅ ᴘᴀɪʀᴇᴅ\n\nʙᴏᴛ ꜱᴛᴀʀᴛꜱ ɪɴ 2 ᴍɪɴᴜᴛᴇꜱ.')
      } else {
        sessionId = target
      }

      try {
        await deployBot(randomAppName(), sessionId)
      } catch (e) {
        console.error('[PAIR] deploy failed:', e?.message || e)
        if (wasPaired) await editStatus('❌ ᴅᴇᴘʟᴏʏ ꜰᴀɪʟᴇᴅ\n\n' + (e.message || 'Unknown error'))
      }

    } catch (err) {
      console.error('[PAIR ERROR]', err?.stack || err?.message || err)
      if (statusMsg) await editStatus('❌ ꜰᴀɪʟᴇᴅ\n\n' + (err.message || 'Unknown error'))
    }
  }
}
