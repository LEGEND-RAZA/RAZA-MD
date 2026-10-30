// plugins/pair.js — RAZA MD pair + auto-deploy
// Usage: .pair 923001234567
//
// Flow:
//   1. Send ONE message with the pairing code
//   2. User enters code in WhatsApp
//   3. Edit the SAME message → "Paired. Bot starts in 2 minutes."
//   4. Deploy runs silently in the background
//   5. If deploy fails → edit the SAME message to show the error
//
// Silent: no progress messages, no "starting…", nothing else.

const PAIR_SERVER = (process.env.PAIR_SERVER_URL || 'https://pair-web-3e08f4e68faf.herokuapp.com').replace(/\/$/, '')

const PAIR_TIMEOUT   = 5 * 60 * 1000    // 5 min for user to enter code
const DEPLOY_TIMEOUT = 12 * 60 * 1000   // 12 min for Heroku build
const PAIR_POLL      = 2000
const DEPLOY_POLL    = 3000

const sleep = ms => new Promise(r => setTimeout(r, ms))
const send  = (sock, jid, text, quoted) => sock.sendMessage(jid, { text }, { quoted })

const phoneValid   = n => /^\d{7,15}$/.test(n)
const sessionValid = s => /^RAZA_[A-Za-z0-9_-]{10,100}$/.test(s)

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, options)
  const data = await res.json().catch(() => ({}))
  return { res, data }
}

// Base36 random suffix → 1.7M unique combinations
function randomAppName() {
  const id = Math.random().toString(36).slice(2, 6)
  return `raza-${id}`
}

// ──────────────────────────────────────────────────────────────
// PAIR: calls your pair server, polls until session is ready
// ──────────────────────────────────────────────────────────────
async function pairNumber(number, onCode) {
  const { res, data } = await fetchJSON(`${PAIR_SERVER}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ number })
  })

  if (!res.ok || data.success === false) {
    throw new Error(data.error || `Pair server error (HTTP ${res.status})`)
  }

  const jobId = data.id
  if (!jobId) throw new Error('Pair server returned no job ID')

  let lastCode = data.code || ''
  let codeSent = false
  const startedAt = Date.now()

  // If the initial response already contained a code, show it immediately
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
      continue   // transient network error, keep polling
    }

    if (st.error) throw new Error(st.error)

    // New code appeared after initial poll
    if (st.code && st.code !== lastCode && !codeSent) {
      lastCode = st.code
      codeSent = true
      await onCode(st.code)
    }

    // Session ready
    if (st.status === 'ready' && st.session) {
      return st.session
    }

    if (st.status === 'error') {
      throw new Error(st.error || 'Pairing failed')
    }
  }

  throw new Error('Pairing timed out — no code entered')
}

// ──────────────────────────────────────────────────────────────
// DEPLOY: calls your deploy server, polls until live or failed
// ──────────────────────────────────────────────────────────────
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
      continue   // transient network error
    }

    if (st.status === 'live') {
      return { appName, jobId }
    }
    if (st.status === 'failed') {
      throw new Error(st.error || 'Deployment failed')
    }
  }

  throw new Error('Deploy timed out — check Heroku dashboard')
}

// ──────────────────────────────────────────────────────────────
// COMMAND
// ──────────────────────────────────────────────────────────────
export default {
  command: ['pair'],
  category: 'owner',
  description: 'Pair WhatsApp and auto-deploy RAZA-MD silently',

  async run({ sock, message, args, isOwner }) {
    if (!isOwner) return
    const jid = message?.key?.remoteJid
    if (!jid) return

    const target = (args?.[0] || '').trim()

    // Validate input — silent fail on garbage input
    if (!phoneValid(target) && !sessionValid(target)) return

    let trackedMsg = null

    // Edit the tracked message in place
    const edit = async (text) => {
      if (!trackedMsg) return
      try {
        await sock.sendMessage(jid, { text, edit: trackedMsg.key })
      } catch (e) {
        console.error('[PAIR] edit failed:', e?.message || e)
      }
    }

    try {
      let sessionId = ''
      let wasPaired = false

      // ─── Path A: phone number → pair first, then deploy ───
      if (phoneValid(target)) {
        sessionId = await pairNumber(target, async (code) => {
          // The ONLY visible message: the pairing code
          trackedMsg = await sock.sendMessage(jid, { text: code }, { quoted: message })
        })

        wasPaired = true

        // Edit the SAME message to the confirmation
        await edit('✅ ᴘᴀɪʀᴇᴅ\n\nʏᴏᴜʀ ʙᴏᴛ ᴡɪʟʟ ꜱᴛᴀʀᴛ ᴡɪᴛʜɪɴ 2 ᴍɪɴᴜᴛᴇꜱ.')
      }

      // ─── Path B: existing session → silent deploy (no message sent) ───
      else {
        sessionId = target
      }

      // ─── AUTO-DEPLOY: starts immediately ───
      const appName = randomAppName()

      try {
        await deployBot(appName, sessionId)

        // Success: nothing to say if paired.
        // If it was session-only, still silent (user knows).
        // If paired, user already saw "Bot starts in 2 minutes" — leave it.

      } catch (deployErr) {
        // Deploy failed — only surface it if we have a message to edit
        console.error('[PAIR] deploy failed:', deployErr?.message || deployErr)
        if (wasPaired) {
          await edit(
            '❌ ᴅᴇᴘʟᴏʏ ꜰᴀɪʟᴇᴅ\n\n' +
            (deployErr.message || 'Unknown error')
          )
        }
      }

    } catch (err) {
      console.error('[PAIR ERROR]', err?.stack || err?.message || err)

      // If we already sent the code message, edit it. Otherwise stay silent.
      if (trackedMsg) {
        await edit(
          '❌ ꜰᴀɪʟᴇᴅ\n\n' +
          (err.message || 'Unknown error')
        )
      }
    }
  }
}
