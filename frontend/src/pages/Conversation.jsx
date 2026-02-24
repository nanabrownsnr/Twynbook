import { useParams, Link } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import { apiFetch, getToken } from '../auth'

const API = '/api'

// WebRTC media server URL. When unset we use same origin + /webrtc (app serves it on same host).
// Set VITE_MEDIA_SERVER_WS_URL to override (e.g. ws://other:8765). Set to empty string to disable WebRTC.
function getMediaServerWsBase() {
  const env = typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_MEDIA_SERVER_WS_URL
  const v = env != null ? String(env).trim() : null
  if (v === '') return ''
  if (v) return v.replace(/\/$/, '')
  if (typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${window.location.host}/webrtc`
  }
  return '/webrtc'
}

function chatStreamWebSocketUrl(personaId) {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.host
  const token = getToken()
  const path = `/api/personas/${personaId}/chat/stream`
  return token ? `${proto}//${host}${path}?token=${encodeURIComponent(token)}` : `${proto}//${host}${path}`
}


export default function Conversation() {
  const { personaId } = useParams()
  const [persona, setPersona] = useState(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const idleUrl = personaId ? `${API}/personas/${personaId}/idle-video` : null
  const previewUrl = personaId ? `${API}/personas/${personaId}/preview` : null
  const [replyState, setReplyState] = useState({ current: null, queue: [], streamDone: false })
  const [showReply, setShowReply] = useState(false)
  const [idleVideoError, setIdleVideoError] = useState(false)
  const [streamError, setStreamError] = useState(null)
  const idleVideoRef = useRef(null)
  const replyVideoRef = useRef(null)
  const clearReplyTimeoutRef = useRef(null)
  const clearReplyPendingRef = useRef(false)
  const longWaitTimeoutRef = useRef(null)
  const gotFirstClipRef = useRef(false)
  const lastClipLongFallbackRef = useRef(null)
  const RECOVERY_SEC = 90
  const chatWsRef = useRef(null)
  const mseRef = useRef({ byIndex: {}, revoke: () => { } })
  const stallTimeoutRef = useRef(null)
  const replyPlayingUrl = replyState.current
  const isSpeaking = showReply || sending
  const isStreaming = sending || !replyState.streamDone
  const isGenerating = sending && !gotFirstClipRef.current

  // When clip ended before next was queued, queue gets filled later — advance so we don't stay frozen
  useEffect(() => {
    const v = replyVideoRef.current
    if (!v || !replyState.current || replyState.queue.length === 0) return
    if (!v.ended || v.src !== replyState.current) return
    setReplyState((prev) => {
      if (prev.queue.length === 0) return prev
      console.info('[reply] catch-up advance (clip had ended before next was queued)')
      return { ...prev, current: prev.queue[0], queue: prev.queue.slice(1) }
    })
  }, [replyState.current, replyState.queue.length])

  useEffect(() => {
    if (!personaId) return
    apiFetch(`${API}/personas/${personaId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setPersona)
      .catch(() => setPersona(null))
  }, [personaId])

  // Do NOT close chat/signaling WebSockets in a useEffect cleanup. In React 18 Strict Mode
  // the component unmounts and remounts, which would run cleanup and close the WS right
  // after "started", killing the stream. Only close explicitly: in onclose handler, or
  // in fallbackToMSE. If user navigates away, the WS will eventually be GC'd or we can
  // close on route change elsewhere.

  const prevUrlRef = useRef(null)
  useEffect(() => {
    const v = replyVideoRef.current
    if (!v || !replyPlayingUrl) return

    v.muted = true
    v.src = replyPlayingUrl
    try { v.load() } catch (_) { }

    v.play().catch((err) => {
      console.warn('[reply] play() failed (likely autoplay policy):', err)
    })
  }, [replyPlayingUrl])

  function transitionToIdle() {
    if (lastClipLongFallbackRef.current) {
      clearTimeout(lastClipLongFallbackRef.current)
      lastClipLongFallbackRef.current = null
    }
    setShowReply(false)
    clearReplyPendingRef.current = true
    idleVideoRef.current?.play().catch(() => {
      clearReplyPendingRef.current = false
    })

    if (clearReplyPendingRef.current) clearReplyPendingRef.current = false
    // 2) After the reply-layer fade-out transition (~350ms), clear state and revoke blob URLs.
    //    Doing this after the fade prevents a black flash from the reply video when its blob is revoked.
    const FADE_MS = 400
    clearReplyTimeoutRef.current = setTimeout(() => {
      clearReplyTimeoutRef.current = null
      // Only clear if we haven't started a NEW message in the meantime
      setSending(s => {
        if (!s) {
          setReplyState({ current: null, queue: [], streamDone: false })
          const revoke = mseRef.current.revoke
          if (revoke) setTimeout(revoke, 100)
        }
        return s
      })
    }, FADE_MS)
  }

  // --- Utility functions for Streaming (moved to component scope for accessibility) ---
  const CODECS = 'video/mp4; codecs="avc1.42401E,mp4a.40.2"'


  function handleStreamEvent(event, data) {
    if (event === 'video_start') {
      gotFirstClipRef.current = true
      if (longWaitTimeoutRef.current) { clearTimeout(longWaitTimeoutRef.current); longWaitTimeoutRef.current = null }
      // We have interaction credit from Send button, so we can unmute
      if (replyVideoRef.current) {
        try { replyVideoRef.current.muted = false } catch (_) { }
      }
    } else if (event === 'done') {
      setReplyState((prev) => ({ ...prev, streamDone: true }))
      setTimeout(() => transitionToIdle(), 2000)
    } else if (event === 'error') {
      setStreamError(data.error || 'Stream failed')
      setShowReply(false)
      setSending(false)
    }
  }

  function handleBinaryChunk(chunk) {
    const { sb, queue, appending, pending } = mseRef.current
    if (!sb) {
      if (pending) pending.push(chunk)
      return
    }
    if (appending[0] || queue.length > 0) {
      queue.push(chunk)
    } else {
      appending[0] = true
      try {
        sb.appendBuffer(chunk)
        // Explicitly check if we can resume playback after appending new data
        const v = replyVideoRef.current
        if (v && v.paused && gotFirstClipRef.current) {
          v.play().catch(() => { })
        }
      } catch (err) {
        console.error('[MSE] append error', err)
        appending[0] = false
      }
    }
  }

  function runMSEFlow(text) {
    if (chatWsRef.current) { try { chatWsRef.current.close() } catch (_) { } }
    const wsUrl = chatStreamWebSocketUrl(personaId)
    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'
    chatWsRef.current = ws
    ws.onopen = () => {
      const payload = { message: text }
      ws.send(JSON.stringify(payload))
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data)
          handleStreamEvent(msg.event, msg.data || {})
        } catch (_) { }
      } else if (ev.data instanceof ArrayBuffer) {
        handleBinaryChunk(ev.data)
      }
    }
    ws.onclose = () => { chatWsRef.current = null }
  }

  const sendMessage = (e) => {
    if (e) e.preventDefault()
    const text = input.trim()
    if (!text || sending || !personaId) return

    // 1) Cleanup previous response state
    if (clearReplyTimeoutRef.current) {
      clearTimeout(clearReplyTimeoutRef.current)
      clearReplyTimeoutRef.current = null
    }
    if (longWaitTimeoutRef.current) {
      clearTimeout(longWaitTimeoutRef.current)
      longWaitTimeoutRef.current = null
    }

    setInput('')
    setSending(true)
    setStreamError(null)
    gotFirstClipRef.current = false

    // To prevent black flash: hide the speaking layer but KEEP the current src 
    // until we actually have the first segment of the new one ready.
    setShowReply(false)

    // 2) Setup NEW MediaSource for this specific response
    const ms = new MediaSource()
    const blobUrl = URL.createObjectURL(ms)

    // MSE State: chunks arriving before SourceBuffer is ready go into pending
    const mseState = {
      sb: null,
      queue: [],
      appending: [false],
      pending: [], // Chunks arriving while ms is opening
      revoke: () => { try { URL.revokeObjectURL(blobUrl) } catch (_) { } }
    }
    mseRef.current = mseState

    ms.onsourceopen = () => {
      console.info('[MSE] Source opened');
      try {
        const sb = ms.addSourceBuffer(CODECS)
        sb.mode = 'sequence'
        sb.onupdateend = () => {
          mseState.appending[0] = false
          if (mseState.queue.length > 0) {
            mseState.appending[0] = true
            sb.appendBuffer(mseState.queue.shift())
          } else {
            // Queue empty, check if we should be playing
            const v = replyVideoRef.current
            if (v && v.paused && gotFirstClipRef.current) {
              v.play().catch(() => { })
            }
          }
        }
        mseState.sb = sb
        // Push any chunks that arrived while we were opening
        if (mseState.pending.length > 0) {
          console.info('[MSE] Appending %d pending chunks', mseState.pending.length);
          while (mseState.pending.length > 0) {
            const chunk = mseState.pending.shift()
            if (mseState.appending[0]) {
              mseState.queue.push(chunk)
            } else {
              mseState.appending[0] = true
              sb.appendBuffer(chunk)
            }
          }
        }
      } catch (err) {
        console.error('[MSE] addSourceBuffer failed', err)
      }
    }

    // Update replyPlayingUrl which triggers the <video src={url}> useEffect
    setReplyState((prev) => ({ ...prev, current: blobUrl, queue: [], streamDone: false }))

    // Final safety timeout for "Thinking..." state
    longWaitTimeoutRef.current = setTimeout(() => {
      longWaitTimeoutRef.current = null
      if (gotFirstClipRef.current) return
      setStreamError('Response is taking too long. Please try again.')
      setSending(false)
      transitionToIdle()
    }, RECOVERY_SEC * 1000)

    runMSEFlow(text)
  }



  const handleReplyEnded = () => {
    setReplyState((prev) => {
      console.info('[reply] onEnded', {
        current: prev.current,
        queueLen: prev.queue.length,
        streamDone: prev.streamDone,
      })
      if (prev.queue.length > 0) {
        // Advance to next clip: keep reply layer visible, no gap/flash (next clip is preloaded)
        console.info('[reply] advancing to next clip')
        return { ...prev, current: prev.queue[0], queue: prev.queue.slice(1) }
      }
      // No more clips in queue: only switch to idle when stream is done (avoids speak → idle → speak when clip 1 is still loading)
      if (!prev.streamDone) {
        console.info('[reply] ended but waiting for stream to finish')
        return prev
      }
      // Stream done and no more clips — transition to idle (clears fallback timers)
      console.info('[reply] transition to idle')
      transitionToIdle()
      return prev
    })
  }

  if (!persona && personaId) {
    return (
      <div className="conv">
        <p>Loading…</p>
      </div>
    )
  }
  if (!persona) {
    return (
      <div className="conv">
        <p>Persona not found.</p>
        <Link to="/app">Back to list</Link>
      </div>
    )
  }

  return (
    <div className="conv">
      <header className="conv-header">
        <Link to="/app">← Back</Link>
        <h1>{persona.name}</h1>
        <Link to={`/persona/${personaId}/edit`} className="edit-link">Edit</Link>
      </header>
      <div className="video-wrap" aria-hidden="true">
        {isGenerating && (
          <div className="streaming-status generating">Thinking...</div>
        )}
        {isStreaming && !isGenerating && replyState.queue.length > 0 && (
          <div className="streaming-status next">Next clip ready</div>
        )}
        {idleVideoError && previewUrl && (
          <img src={previewUrl} alt="" className="video-layer poster-fallback" style={{ opacity: showReply ? 0 : 1 }} />
        )}
        <video
          ref={idleVideoRef}
          src={idleUrl && !idleVideoError ? idleUrl : undefined}
          muted
          loop
          playsInline
          autoPlay
          preload="auto"
          poster={previewUrl || undefined}
          className="video-layer"
          style={{ opacity: showReply ? 0 : 1 }}
          onError={() => setIdleVideoError(true)}
          onPlaying={() => {
            if (clearReplyPendingRef.current) {
              clearReplyPendingRef.current = false
              setShowReply(false)
            }
          }}
        />
        <video
          ref={replyVideoRef}
          muted
          autoPlay
          loop={false}
          playsInline
          preload="auto"
          className={`video-layer reply-layer${!showReply ? ' reply-hiding' : ''}`}
          style={{
            opacity: showReply ? 1 : 0,
            pointerEvents: 'none',
            // Kill transition instantly when starting a new message to avoid black flash
            transition: isGenerating ? 'none' : undefined
          }}
          onPlaying={() => {
            if (stallTimeoutRef.current) {
              clearTimeout(stallTimeoutRef.current);
              stallTimeoutRef.current = null;
            }
            if (longWaitTimeoutRef.current) {
              clearTimeout(longWaitTimeoutRef.current);
              longWaitTimeoutRef.current = null;
            }
            console.info('[reply] onPlaying', {
              src: replyVideoRef.current?.src,
              readyState: replyVideoRef.current?.readyState,
            })
            setShowReply(true)
          }}
          onCanPlay={() => {
            // Some browsers need this to recover from a deep stall
            if (replyVideoRef.current && replyVideoRef.current.readyState >= 2) {
              if (stallTimeoutRef.current) {
                clearTimeout(stallTimeoutRef.current);
                stallTimeoutRef.current = null;
              }
              if (longWaitTimeoutRef.current) {
                clearTimeout(longWaitTimeoutRef.current);
                longWaitTimeoutRef.current = null;
              }
              setShowReply(true);
            }
          }}
          onCanPlayThrough={() => {
            if (stallTimeoutRef.current) {
              clearTimeout(stallTimeoutRef.current);
              stallTimeoutRef.current = null;
            }
            if (longWaitTimeoutRef.current) {
              clearTimeout(longWaitTimeoutRef.current);
              longWaitTimeoutRef.current = null;
            }
            setShowReply(true);
          }}
          onTimeUpdate={() => {
            if (!showReply && replyVideoRef.current && !replyVideoRef.current.paused) {
              setShowReply(true)
            }
          }}
          onEnded={handleReplyEnded}
          onWaiting={() => {
            console.info('[reply] waiting...');
            // Fade back to idle if we stall FOR LONG, to avoid black screen
            // but ignore short micro-stalls during buffer transitions.
            if (stallTimeoutRef.current) clearTimeout(stallTimeoutRef.current);
            stallTimeoutRef.current = setTimeout(() => {
              console.warn('[reply] long stall detected, returning to idle');
              setShowReply(false);
              stallTimeoutRef.current = null;

              // HEURISTIC: If we've been waiting for > 10s and still no playback,
              // something is wrong with the MSE buffer or connection.
              // We should at least release the UI lock so the user can try again.
              if (sending && !gotFirstClipRef.current) {
                // We're still in "Thinking..." state, let the longWaitTimeout handle it
              } else if (sending) {
                // We were speaking but got stuck. 
              }
            }, 500);

            // Separate safety timer to unlock the UI if we're completely frozen
            if (longWaitTimeoutRef.current) clearTimeout(longWaitTimeoutRef.current);
            longWaitTimeoutRef.current = setTimeout(() => {
              console.error('[reply] Safety timeout: unlocking UI due to persistent freeze');
              setSending(false);
              transitionToIdle();
            }, 10000); // 10s of cumulative waiting = stuck
          }}
          onStalled={() => {
            console.warn('[reply] stalled');
            setShowReply(false);
          }}
          onError={(e) => {
            if (!replyVideoRef.current?.src) return
            console.warn('[reply] video error', {
              src: replyVideoRef.current?.src,
              readyState: replyVideoRef.current?.readyState,
              networkState: replyVideoRef.current?.networkState,
              mediaError: replyVideoRef.current?.error?.message || replyVideoRef.current?.error?.code || null,
            })
            console.warn('Reply video error (may recover when MSE buffers data)', e.nativeEvent)
          }}
        />
      </div>
      <div className="conv-bottom">
        {streamError && <p className="stream-error">{streamError}</p>}
        <form onSubmit={sendMessage} className="input-form">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message…"
            disabled={sending}
          />
          <button type="submit" disabled={sending || !input.trim()}>Send</button>
        </form>
      </div>
      <style>{`
        .conv { position: fixed; inset: 0; display: flex; flex-direction: column; background: #000; color: #e4e4e7; }
        .conv a { color: #a78bfa; }
        .conv-header { position: relative; z-index: 20; flex-shrink: 0; padding: 0.5rem 0.75rem; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; background: rgba(0,0,0,0.85); border-bottom: 1px solid rgba(255,255,255,0.1); }
        .conv-header a { margin-right: 0; color: #a78bfa; }
        .conv h1 { font-family: var(--font-heading); font-size: 0.95rem; font-weight: 600; margin: 0; flex: 1; color: #fff; }
        .conv-header .edit-link { color: #a78bfa; font-size: 0.85rem; }
        .video-wrap { position: relative; z-index: 0; flex: 1; min-height: 0; width: 100%; background: #000; overflow: hidden; pointer-events: none; }
        .video-wrap .video-layer { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; transition: opacity 0.35s ease-out; pointer-events: none; }
        .video-wrap .video-layer.poster-fallback { z-index: 0; }
        .video-wrap .video-layer.reply-layer { z-index: 1; transition: opacity 0.3s ease-in-out; }
        .video-wrap .video-layer.reply-layer.reply-hiding { transition: opacity 0.35s ease-out; }
        .conv-bottom { position: relative; z-index: 20; flex-shrink: 0; background: rgba(0,0,0,0.9); border-top: 1px solid rgba(255,255,255,0.1); }
        .input-form { display: flex; gap: 0.5rem; padding: 0.75rem 1rem; width: 100%; }
        .input-form input { flex: 1; padding: 0.6rem 0.75rem; border-radius: var(--radius); border: 1px solid rgba(255,255,255,0.2); background: rgba(255,255,255,0.08); color: #fff; }
        .input-form input::placeholder { color: rgba(255,255,255,0.5); }
        .input-form input:focus { outline: none; border-color: var(--primary); }
        .input-form button { padding: 0.6rem 1rem; border-radius: var(--radius); border: none; background: var(--primary); color: #fff; font-weight: 500; cursor: pointer; }
        .input-form button:hover:not(:disabled) { background: var(--primary-hover); }
        .input-form button:disabled { opacity: 0.5; cursor: not-allowed; }
        .stream-error { color: #f87171; font-size: 0.85rem; padding: 0 1rem; margin: 0 0 0.25rem; }
        .streaming-status { position: absolute; bottom: 0.75rem; left: 50%; transform: translateX(-50%); z-index: 2; padding: 0.35rem 0.75rem; border-radius: 999px; font-size: 0.8rem; background: rgba(0,0,0,0.75); color: rgba(255,255,255,0.9); pointer-events: none; }
        .streaming-status.generating { animation: pulse 1.5s ease-in-out infinite; }
        .streaming-status.next { opacity: 0.85; }
        @keyframes pulse { 50% { opacity: 0.7; } }
      `}</style>
    </div>
  )
}
