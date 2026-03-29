import { useParams, Link } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import { apiFetch, getToken } from '../auth'
import { isVideoMseAvailable, pickMuxedCodecString } from '../mseVideo'

const API = '/api'
const USE_MSE = !(
  typeof import.meta !== 'undefined' &&
  import.meta.env &&
  import.meta.env.VITE_DITTO_STREAMING === '0'
)
const AUDIO_CODECS = 'audio/mp4; codecs="mp4a.40.2"'
const AUDIO_SAMPLE_RATE = 16000
const AUDIO_START_PAD_SEC = 0.05

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

function getAudioRtcWsUrl(personaId, { sttOnly = false } = {}) {
  const q = sttOnly ? '?stt_only=1' : ''
  const env = typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_AUDIO_RTC_WS_URL
  if (env && String(env).length > 0) {
    let base = String(env).trim().replace(/\/$/, '')
    if (sttOnly) base += (base.includes('?') ? '&' : '?') + 'stt_only=1'
    return base
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/api/personas/${personaId}/audio/rtc${q}`
}

function chatStreamWebSocketUrl(personaId) {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.host
  const token = getToken()
  const path = `/api/personas/${personaId}/chat/stream`
  return token ? `${proto}//${host}${path}?token=${encodeURIComponent(token)}` : `${proto}//${host}${path}`
}

/** Seconds of muxed A/V buffered ahead of currentTime (video MSE reply). */
function muxedBufferedAheadSec(v) {
  if (!v || !v.buffered || v.buffered.length === 0) return 0
  const t = Number.isFinite(v.currentTime) ? v.currentTime : 0
  const b = v.buffered
  for (let i = 0; i < b.length; i++) {
    if (b.start(i) <= t && t < b.end(i)) return b.end(i) - t
  }
  if (t < b.start(0)) return Math.max(0, b.end(0) - t)
  const last = b.length - 1
  return Math.max(0, b.end(last) - t)
}


export default function Conversation() {
  const { personaId } = useParams()
  const [persona, setPersona] = useState(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [mode, setMode] = useState('audio')
  const modeRef = useRef(mode)
  modeRef.current = mode
  const [chatLog, setChatLog] = useState([])
  const idleUrl = personaId ? `${API}/personas/${personaId}/idle-video` : null
  const previewUrl = personaId ? `${API}/personas/${personaId}/preview` : null
  const [replyState, setReplyState] = useState({ current: null, queue: [], streamDone: false })
  const [audioState, setAudioState] = useState({ current: null, queue: [], streamDone: false })
  const [showReply, setShowReply] = useState(false)
  const [idleVideoError, setIdleVideoError] = useState(false)
  const [idlePlaying, setIdlePlaying] = useState(false)
  const [streamError, setStreamError] = useState(null)
  const [micActive, setMicActive] = useState(false)
  const [audioSpeaking, setAudioSpeaking] = useState(false)
  const [micError, setMicError] = useState(null)
  /** Video mode: voice-first UI; text field revealed on demand. */
  const [showVideoTextInput, setShowVideoTextInput] = useState(false)
  const idleVideoRef = useRef(null)
  const replyVideoRef = useRef(null)
  const audioRef = useRef(null)
  const clearReplyTimeoutRef = useRef(null)
  const clearReplyPendingRef = useRef(false)
  const longWaitTimeoutRef = useRef(null)
  const gotFirstClipRef = useRef(false)
  /** Drives "Thinking…" UI; refs alone do not re-render. */
  const [firstClipReceived, setFirstClipReceived] = useState(false)
  const lastClipLongFallbackRef = useRef(null)
  const RECOVERY_SEC = 90
  const chatWsRef = useRef(null)
  const mseRef = useRef({ byIndex: {}, revoke: () => { } })
  const audioMseRef = useRef({ sb: null, queue: [], appending: [false], pending: [], revoke: () => {} })
  const audioCtxRef = useRef(null)
  const audioPlayheadRef = useRef(0)
  const audioNodesRef = useRef([])
  const audioPlaybackTimerRef = useRef(null)
  const audioPlaybackLoggedRef = useRef(false)
  const audioRtcRef = useRef({ pc: null, ws: null, dc: null, stream: null, remoteStream: null, pingTimer: null, sttOnly: null })
  const iceServersRef = useRef(null)
  const stallTimeoutRef = useRef(null)
  const pendingNewClipRef = useRef(false)
  const streamDoneRef = useRef(false)
  const perfRef = useRef({ start: 0, videoStart: 0, audioStart: 0, audioFirstChunk: 0 })
  const abortRef = useRef(false)
  const streamingTextRef = useRef('')
  const hasStreamedTextRef = useRef(false)
  const replyPlayingUrl = replyState.current
  const isSpeaking = showReply || sending || audioSpeaking
  const isStreaming = sending || !(mode === 'audio' ? audioState.streamDone : replyState.streamDone)
  const isGenerating = sending && !firstClipReceived
  const canStop = sending || (mode === 'audio' ? !!audioState.current : !!replyState.current)
  const chatKey = personaId ? `twynbook:chat:${personaId}` : null

  const resetTimers = () => {
    if (clearReplyTimeoutRef.current) {
      clearTimeout(clearReplyTimeoutRef.current)
      clearReplyTimeoutRef.current = null
    }
    if (longWaitTimeoutRef.current) {
      clearTimeout(longWaitTimeoutRef.current)
      longWaitTimeoutRef.current = null
    }
    if (stallTimeoutRef.current) {
      clearTimeout(stallTimeoutRef.current)
      stallTimeoutRef.current = null
    }
    if (lastClipLongFallbackRef.current) {
      clearTimeout(lastClipLongFallbackRef.current)
      lastClipLongFallbackRef.current = null
    }
  }

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

  useEffect(() => {
    if (!chatKey) return
    try {
      const raw = window.localStorage.getItem(chatKey)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) setChatLog(parsed)
      }
    } catch (_) { }
  }, [chatKey])

  useEffect(() => {
    if (!chatKey) return
    try {
      window.localStorage.setItem(chatKey, JSON.stringify(chatLog))
    } catch (_) { }
  }, [chatKey, chatLog])

  const chatLogScrollRef = useRef(null)
  useEffect(() => {
    const el = chatLogScrollRef.current
    if (!el) return
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
  }, [chatLog, mode])

  // Do NOT close chat/signaling WebSockets in a useEffect cleanup. In React 18 Strict Mode
  // the component unmounts and remounts, which would run cleanup and close the WS right
  // after "started", killing the stream. Only close explicitly: in onclose handler, or
  // in fallbackToMSE. If user navigates away, the WS will eventually be GC'd or we can
  // close on route change elsewhere.

  const prevUrlRef = useRef(null)
  useEffect(() => {
    const v = replyVideoRef.current
    if (!v || !replyPlayingUrl) return

    // MSE blob: stay muted until muxed buffer preroll in resumeReplyPlayback. Direct MP4 URLs (non-streaming Ditto) play with sound.
    v.muted = replyPlayingUrl.startsWith('blob:')
    v.src = replyPlayingUrl
    try { v.load() } catch (_) { }

    v.play().catch((err) => {
      console.warn('[reply] play() failed (likely autoplay policy):', err)
    })
  }, [replyPlayingUrl])

  useEffect(() => {
    const a = audioRef.current
    if (!a || !audioState.current) return
    a.src = audioState.current
    a.play().catch(() => { })
  }, [audioState.current])

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
  /** Preroll before unmuting muxed Ditto A/V (one timeline; avoids mouth lagging separate early audio). */
  const MIN_MUXED_BUFFER_SEC = 0.18
  const MIN_MUXED_BUFFER_STREAM_DONE_SEC = 0.03

  function resumeReplyPlayback() {
    const v = replyVideoRef.current
    setShowReply(true)
    if (!v) return
    const ahead = muxedBufferedAheadSec(v)
    const minBuf = streamDoneRef.current ? MIN_MUXED_BUFFER_STREAM_DONE_SEC : MIN_MUXED_BUFFER_SEC
    const canStart = ahead >= minBuf || (streamDoneRef.current && ahead > 0)
    if (!canStart) return
    try {
      v.muted = false
    } catch (_) { }
    if (v.paused || v.readyState < 2) {
      v.play().catch(() => { })
    }
  }


  function handleStreamEvent(event, data) {
    if (event === 'video_start') {
      gotFirstClipRef.current = true
      setFirstClipReceived(true)
      if (longWaitTimeoutRef.current) { clearTimeout(longWaitTimeoutRef.current); longWaitTimeoutRef.current = null }
      pendingNewClipRef.current = true
      if (!perfRef.current.videoStart && perfRef.current.start) {
        perfRef.current.videoStart = performance.now()
        const dt = (perfRef.current.videoStart - perfRef.current.start) / 1000
        console.info(`[ttfr] video_start at ${dt.toFixed(2)}s`)
      }
      // Unmute only in resumeReplyPlayback once muxed buffer crosses preroll (lip-sync clock).
      resumeReplyPlayback()
    } else if (event === 'audio_start') {
      gotFirstClipRef.current = true
      setFirstClipReceived(true)
      if (longWaitTimeoutRef.current) { clearTimeout(longWaitTimeoutRef.current); longWaitTimeoutRef.current = null }
      if (!perfRef.current.audioStart && perfRef.current.start) {
        perfRef.current.audioStart = performance.now()
        const dt = (perfRef.current.audioStart - perfRef.current.start) / 1000
        console.info(`[ttfr] audio_start at ${dt.toFixed(2)}s`)
      }
      setAudioSpeaking(true)
    } else if (event === 'text_delta') {
      const delta = data?.text
      if (!delta) return
      hasStreamedTextRef.current = true
      streamingTextRef.current += delta
      setChatLog((prev) => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (last && last.role === 'assistant' && last.streaming) {
          next[next.length - 1] = { ...last, text: streamingTextRef.current }
        } else {
          next.push({ role: 'assistant', text: streamingTextRef.current, streaming: true })
        }
        return next
      })
    } else if (event === 'clip') {
      if (data?.mode === 'audio') {
        const url = data?.audio_url
        if (url) {
          setAudioState((prev) => {
            if (!prev.current) return { ...prev, current: url }
            return { ...prev, queue: [...prev.queue, url] }
          })
        }
        if (data?.text && !hasStreamedTextRef.current) {
          setChatLog((prev) => [...prev, { role: 'assistant', text: data.text }])
        }
        return
      }
      if (data?.text && !hasStreamedTextRef.current) {
        setChatLog((prev) => [...prev, { role: 'assistant', text: data.text }])
      }
      if (isVideoMseAvailable()) {
        // Streaming Ditto sends fMP4 binary; this event is metadata only.
        if (data?.streaming !== false) return
        // Non-streaming Ditto (e.g. DITTO_STREAMING unset): no segments — play the MP4 URL instead of an empty MediaSource.
        const rel = data?.url
        if (!rel) return
        const abs =
          rel.startsWith('http') ? rel : rel.startsWith('/') ? rel : `${API}/${rel}`
        try {
          mseRef.current.revoke?.()
        } catch (_) {}
        mseRef.current = { byIndex: {}, revoke: () => {} }
        setReplyState((prev) => {
          if (!prev.current) return { ...prev, current: abs }
          return { ...prev, queue: [...prev.queue, abs] }
        })
        gotFirstClipRef.current = true
        setFirstClipReceived(true)
        setShowReply(true)
        return
      }
      const url = data?.url
      if (!url) return
      setReplyState((prev) => {
        if (!prev.current) {
          return { ...prev, current: url }
        }
        return { ...prev, queue: [...prev.queue, url] }
      })
    } else if (event === 'done') {
      streamDoneRef.current = true
      if (hasStreamedTextRef.current) {
        setChatLog((prev) => {
          if (prev.length === 0) return prev
          const last = prev[prev.length - 1]
          if (last && last.streaming) {
            return [...prev.slice(0, -1), { ...last, streaming: false }]
          }
          return prev
        })
        hasStreamedTextRef.current = false
        streamingTextRef.current = ''
      }
      setReplyState((prev) => ({ ...prev, streamDone: true }))
      setAudioState((prev) => ({ ...prev, streamDone: true }))
      setAudioSpeaking(false)
      setSending(false)
      resumeReplyPlayback()
      setTimeout(() => transitionToIdle(), 2000)
    } else if (event === 'error') {
      setStreamError(data.error || 'Stream failed')
      setShowReply(false)
      setAudioSpeaking(false)
      setSending(false)
    }
  }

  function handleBinaryChunk(chunk) {
    const { sb, queue, appending, pending } = mseRef.current
    if (!sb) {
      if (pending) pending.push(chunk)
      return
    }
    if (pendingNewClipRef.current && !sb.updating) {
      try {
        const buffered = sb.buffered
        const end = buffered.length > 0 ? buffered.end(buffered.length - 1) : 0
        sb.timestampOffset = end
      } catch (_) { }
      pendingNewClipRef.current = false
    }
    if (appending[0] || queue.length > 0) {
      queue.push(chunk)
    } else {
      appending[0] = true
      try {
        sb.appendBuffer(chunk)
        resumeReplyPlayback()
      } catch (err) {
        console.error('[MSE] append error', err)
        appending[0] = false
      }
    }
  }

  function handleAudioBinaryChunk(chunk) {
    if (!perfRef.current.audioFirstChunk && perfRef.current.start) {
      perfRef.current.audioFirstChunk = performance.now()
      const dt = (perfRef.current.audioFirstChunk - perfRef.current.start) / 1000
      const dtAfterStart = perfRef.current.audioStart ? (perfRef.current.audioFirstChunk - perfRef.current.audioStart) / 1000 : null
      console.info(`[ttfr] audio_first_chunk at ${dt.toFixed(2)}s` + (dtAfterStart != null ? ` (after audio_start ${dtAfterStart.toFixed(2)}s)` : ''))
    }
    const ac = audioCtxRef.current
    if (!ac) return
    if (ac.state === 'suspended') {
      ac.resume().catch(() => {})
    }
    if (!(chunk instanceof ArrayBuffer) || chunk.byteLength === 0) return
    const f32 = new Float32Array(chunk)
    if (!f32.length) return
    const buffer = ac.createBuffer(1, f32.length, AUDIO_SAMPLE_RATE)
    buffer.copyToChannel(f32, 0)
    const source = ac.createBufferSource()
    source.buffer = buffer
    source.connect(ac.destination)
    const startAt = Math.max(ac.currentTime + AUDIO_START_PAD_SEC, audioPlayheadRef.current)
    source.start(startAt)
    audioPlayheadRef.current = startAt + buffer.duration
    audioNodesRef.current.push(source)
    if (!audioPlaybackLoggedRef.current && perfRef.current.start) {
      audioPlaybackLoggedRef.current = true
      const delayMs = Math.max(0, (startAt - ac.currentTime) * 1000)
      if (audioPlaybackTimerRef.current) clearTimeout(audioPlaybackTimerRef.current)
      audioPlaybackTimerRef.current = setTimeout(() => {
        const now = performance.now()
        const dt = (now - perfRef.current.start) / 1000
        const dtAfterStart = perfRef.current.audioStart ? (now - perfRef.current.audioStart) / 1000 : null
        console.info(`[ttfr] audio_playback at ${dt.toFixed(2)}s` + (dtAfterStart != null ? ` (after audio_start ${dtAfterStart.toFixed(2)}s)` : ''))
      }, delayMs)
    }
  }

  function runMSEFlow(text) {
    if (chatWsRef.current) {
      try { chatWsRef.current.__intentionalClose = true } catch (_) { }
      try { chatWsRef.current.close() } catch (_) { }
    }
    const wsUrl = chatStreamWebSocketUrl(personaId)
    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'
    chatWsRef.current = ws
    ws.onopen = () => {
      const payload = { message: text, mode: 'video' }
      ws.send(JSON.stringify(payload))
    }
    ws.onmessage = (ev) => {
      if (abortRef.current) return
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data)
          handleStreamEvent(msg.event, msg.data || {})
        } catch (_) { }
      } else if (ev.data instanceof ArrayBuffer) {
        handleBinaryChunk(ev.data)
      }
    }
    ws.onerror = () => {
      setStreamError('Connection failed. Please try again.')
      setSending(false)
      transitionToIdle()
    }
    ws.onclose = () => {
      chatWsRef.current = null
      if (ws.__intentionalClose) return
      if (abortRef.current) return
      if (!streamDoneRef.current && !gotFirstClipRef.current) {
        setStreamError('Connection closed before streaming started.')
        setSending(false)
        transitionToIdle()
      }
    }
  }

  function runChunkedFlow(text) {
    if (chatWsRef.current) {
      try { chatWsRef.current.__intentionalClose = true } catch (_) { }
      try { chatWsRef.current.close() } catch (_) { }
    }
    const wsUrl = chatStreamWebSocketUrl(personaId)
    const ws = new WebSocket(wsUrl)
    chatWsRef.current = ws
    ws.onopen = () => {
      const payload = { message: text, mode: 'video' }
      ws.send(JSON.stringify(payload))
    }
    ws.onmessage = (ev) => {
      if (abortRef.current) return
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data)
          handleStreamEvent(msg.event, msg.data || {})
        } catch (_) { }
      }
    }
    ws.onerror = () => {
      setStreamError('Connection failed. Please try again.')
      setSending(false)
      transitionToIdle()
    }
    ws.onclose = () => {
      chatWsRef.current = null
      if (ws.__intentionalClose) return
      if (abortRef.current) return
      if (!streamDoneRef.current && !gotFirstClipRef.current) {
        setStreamError('Connection closed before streaming started.')
        setSending(false)
        transitionToIdle()
      }
    }
  }

  function runAudioFlow(text) {
    if (chatWsRef.current) {
      try { chatWsRef.current.__intentionalClose = true } catch (_) { }
      try { chatWsRef.current.close() } catch (_) { }
    }
    const wsUrl = chatStreamWebSocketUrl(personaId)
    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'
    chatWsRef.current = ws
    ws.onopen = () => {
      ws.send(JSON.stringify({ message: text, mode: 'audio' }))
    }
    ws.onmessage = (ev) => {
      if (abortRef.current) return
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data)
          handleStreamEvent(msg.event, msg.data || {})
        } catch (_) { }
      } else if (ev.data instanceof ArrayBuffer) {
        handleAudioBinaryChunk(ev.data)
      }
    }
    ws.onerror = () => {
      setStreamError('Connection failed. Please try again.')
      setSending(false)
      transitionToIdle()
    }
    ws.onclose = () => {
      chatWsRef.current = null
      if (ws.__intentionalClose) return
      if (abortRef.current) return
      if (!streamDoneRef.current && !gotFirstClipRef.current) {
        setStreamError('Connection closed before streaming started.')
        setSending(false)
        transitionToIdle()
      }
    }
  }

  const sendMessage = (e, overrideText = null) => {
    if (e) e.preventDefault()
    const text = (overrideText != null ? String(overrideText) : input).trim()
    if (!text || !personaId) {
      if (!personaId) {
        setStreamError('Missing persona id. Please reload and try again.')
      }
      return
    }
    if (sending) {
      if (overrideText != null) {
        setStreamError('Wait for the current reply to finish, then speak again.')
      }
      return
    }
    // Typing is blocked while the mic is on; STT calls sendMessage(null, transcript) with mic still active.
    if (micActive && overrideText == null) {
      setStreamError('Turn off the mic to type a message.')
      return
    }

    // 1) Cleanup previous response state
    if (clearReplyTimeoutRef.current) {
      clearTimeout(clearReplyTimeoutRef.current)
      clearReplyTimeoutRef.current = null
    }
    if (longWaitTimeoutRef.current) {
      clearTimeout(longWaitTimeoutRef.current)
      longWaitTimeoutRef.current = null
    }

    if (overrideText == null) setInput('')
    setSending(true)
    setStreamError(null)
    abortRef.current = false
    gotFirstClipRef.current = false
    setFirstClipReceived(false)
    streamDoneRef.current = false
    hasStreamedTextRef.current = false
    streamingTextRef.current = ''
    setChatLog((prev) => [...prev, { role: 'user', text }])
    perfRef.current.start = performance.now()
    perfRef.current.videoStart = 0
    perfRef.current.audioStart = 0
    perfRef.current.audioFirstChunk = 0
    audioPlaybackLoggedRef.current = false
    if (audioPlaybackTimerRef.current) {
      clearTimeout(audioPlaybackTimerRef.current)
      audioPlaybackTimerRef.current = null
    }
    if (modeRef.current === 'audio') {
      setAudioState({ current: null, queue: [], streamDone: false })
      setReplyState({ current: null, queue: [], streamDone: false })
      if (audioCtxRef.current) {
        try { audioCtxRef.current.close() } catch (_) { }
      }
      const AudioCtx = window.AudioContext || window.webkitAudioContext
      if (AudioCtx) {
        const ac = new AudioCtx({ sampleRate: AUDIO_SAMPLE_RATE })
        audioCtxRef.current = ac
        audioPlayheadRef.current = ac.currentTime + AUDIO_START_PAD_SEC
        audioNodesRef.current = []
        ac.resume().catch(() => {})
      }
    }

    // To prevent black flash: hide the speaking layer but KEEP the current src 
    // until we actually have the first segment of the new one ready.
    setShowReply(false)
    idleVideoRef.current?.play().catch(() => { })

    if (modeRef.current === 'video' && isVideoMseAvailable()) {
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
        try {
          const codec = pickMuxedCodecString()
          if (!codec) {
            console.error('[MSE] no supported muxed codec')
            return
          }
          const sb = ms.addSourceBuffer(codec)
          // Do not set sb.mode = 'sequence' — breaks Safari; default segments + timestampOffset works.
          sb.onupdateend = () => {
            mseState.appending[0] = false
            if (mseState.queue.length > 0) {
              mseState.appending[0] = true
              if (pendingNewClipRef.current && !sb.updating) {
                try {
                  const buffered = sb.buffered
                  const end = buffered.length > 0 ? buffered.end(buffered.length - 1) : 0
                  sb.timestampOffset = end
                } catch (_) { }
                pendingNewClipRef.current = false
              }
              sb.appendBuffer(mseState.queue.shift())
            } else {
              // Queue empty, check if we should be playing
              resumeReplyPlayback()
            }
          }
          mseState.sb = sb
          // Push any chunks that arrived while we were opening
          if (mseState.pending.length > 0) {
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
    } else {
      setReplyState({ current: null, queue: [], streamDone: false })
      if (longWaitTimeoutRef.current) clearTimeout(longWaitTimeoutRef.current)
      longWaitTimeoutRef.current = setTimeout(() => {
        longWaitTimeoutRef.current = null
        if (gotFirstClipRef.current) return
        setStreamError('Response is taking too long. Please try again.')
        setSending(false)
        transitionToIdle()
      }, RECOVERY_SEC * 1000)
      if (modeRef.current === 'audio') {
        runAudioFlow(text)
      } else {
        runChunkedFlow(text)
      }
    }
  }

  const sendMessageRef = useRef(sendMessage)
  sendMessageRef.current = sendMessage

  const stopMic = () => {
    const curr = audioRtcRef.current
    try { curr.dc && curr.dc.close && curr.dc.close() } catch (_) { }
    try { curr.pc && curr.pc.close && curr.pc.close() } catch (_) { }
    try { curr.ws && curr.ws.close && curr.ws.close() } catch (_) { }
    try { curr.pingTimer && clearInterval(curr.pingTimer) } catch (_) { }
    try { curr.stream && curr.stream.getTracks().forEach(t => t.stop()) } catch (_) { }
    try { curr.remoteStream && curr.remoteStream.getTracks().forEach(t => t.stop()) } catch (_) { }
    try {
      const a = audioRef.current
      if (a) {
        a.pause()
        a.srcObject = null
      }
    } catch (_) { }
    audioRtcRef.current = { pc: null, ws: null, dc: null, stream: null, remoteStream: null, pingTimer: null, sttOnly: null }
    setMicActive(false)
  }

  const startMic = async ({ sttOnly = null } = {}) => {
    if (!personaId || micActive) return
    const resolvedSttOnly = sttOnly == null ? (modeRef.current === 'video') : !!sttOnly
    setMicError(null)
    console.info(resolvedSttOnly ? '[video-stt] startMic' : '[audio] startMic begin')
    try {
      if (!iceServersRef.current) {
        try {
          const resp = await fetch(`${API}/webrtc/ice`)
          const data = await resp.json()
          iceServersRef.current = data.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }]
        } catch (_) {
          iceServersRef.current = [{ urls: 'stun:stun.l.google.com:19302' }]
        }
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      console.info('[audio] got user media')
      // iOS Safari: unlock inline video for MSE playback — STT calls sendMessage outside a tap gesture.
      if (resolvedSttOnly) {
        try {
          const v = replyVideoRef.current
          if (v) {
            v.muted = true
            v.playsInline = true
            v.setAttribute('playsinline', '')
            v.setAttribute('webkit-playsinline', '')
            v.play().catch(() => {})
          }
        } catch (_) {}
      }
      const pc = new RTCPeerConnection({ iceServers: iceServersRef.current })
      const dc = pc.createDataChannel('events')
      const pendingRemote = []
      const pendingLocal = []
      dc.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data)
          if (msg.event === 'user_transcript' && msg.text) {
            const t = String(msg.text).trim()
            if (resolvedSttOnly) {
              if (t) sendMessageRef.current(null, t)
            } else {
              setChatLog((prev) => [...prev, { role: 'user', text: msg.text }])
            }
          } else if (msg.event === 'assistant_text' && msg.text) {
            setChatLog((prev) => [...prev, { role: 'assistant', text: msg.text }])
          } else if (msg.event === 'assistant_start') {
            setAudioSpeaking(true)
          } else if (msg.event === 'assistant_done') {
            setAudioSpeaking(false)
          }
        } catch (_) { }
      }

      const micTrack = stream.getAudioTracks()[0]
      if (micTrack) {
        pc.addTransceiver(micTrack, { direction: 'sendrecv' })
      }

      const ws = new WebSocket(getAudioRtcWsUrl(personaId, { sttOnly: resolvedSttOnly }))
      ws.onmessage = async (ev) => {
        try {
          const msg = JSON.parse(ev.data)
          console.info('[audio] ws message', msg.action || msg.event || '(data)')
          if (msg.action === 'answer') {
            await pc.setRemoteDescription(new RTCSessionDescription({ type: msg.type, sdp: msg.sdp }))
            while (pendingRemote.length) {
              const c = pendingRemote.shift()
              try { await pc.addIceCandidate(c) } catch (_) { }
            }
          } else if (msg.action === 'candidate' && msg.candidate) {
            const rtcCand = new RTCIceCandidate({
              candidate: msg.candidate,
              sdpMid: msg.sdpMid,
              sdpMLineIndex: msg.sdpMLineIndex
            })
            if (!pc.remoteDescription) {
              pendingRemote.push(rtcCand)
            } else {
              await pc.addIceCandidate(rtcCand)
            }
          }
        } catch (_) { }
      }
      ws.onclose = () => {
        console.warn('[audio] ws closed')
        if (micActive) stopMic()
      }
      ws.onerror = () => {
        setMicError('Mic connection failed')
        console.error('[audio] ws error')
        stopMic()
      }

      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return
        const payload = {
          action: 'candidate',
          candidate: ev.candidate.candidate,
          sdpMid: ev.candidate.sdpMid,
          sdpMLineIndex: ev.candidate.sdpMLineIndex
        }
        if (ws.readyState === WebSocket.OPEN && pc.localDescription) {
          ws.send(JSON.stringify(payload))
        } else {
          pendingLocal.push(payload)
        }
      }

      pc.ontrack = (ev) => {
        if (ev.track.kind !== 'audio') return
        const remoteStream = audioRtcRef.current.remoteStream || new MediaStream()
        remoteStream.addTrack(ev.track)
        audioRtcRef.current.remoteStream = remoteStream
        const a = audioRef.current
        if (a) {
          a.srcObject = remoteStream
          a.play().catch(() => {})
        }
        console.info('[audio] remote track added')
      }

      ws.onopen = async () => {
        console.info('[audio] ws open, creating offer')
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        ws.send(JSON.stringify({ action: 'offer', sdp: offer.sdp, type: offer.type }))
        while (pendingLocal.length) {
          ws.send(JSON.stringify(pendingLocal.shift()))
        }
        const pingTimer = setInterval(() => {
          try {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ action: 'ping', ts: Date.now() }))
            }
          } catch (_) { }
        }, 15000)
        audioRtcRef.current.pingTimer = pingTimer
      }

      audioRtcRef.current = { pc, ws, dc, stream, remoteStream: null, pingTimer: null, sttOnly: resolvedSttOnly }
      setMicActive(true)
    } catch (e) {
      setMicError(e?.message || 'Could not access microphone')
      console.error('[audio] startMic failed', e)
      stopMic()
    }
  }

  useEffect(() => () => stopMic(), [])

  const stopPlayback = () => {
    abortRef.current = true
    try { if (chatWsRef.current) chatWsRef.current.__intentionalClose = true } catch (_) { }
    try { chatWsRef.current?.close() } catch (_) { }
    resetTimers()
    gotFirstClipRef.current = false
    setFirstClipReceived(false)
    pendingNewClipRef.current = false
    streamDoneRef.current = false
    setSending(false)
    setStreamError(null)
    setShowReply(false)
    setAudioSpeaking(false)
    setReplyState({ current: null, queue: [], streamDone: true })
    setAudioState({ current: null, queue: [], streamDone: true })
    try { replyVideoRef.current?.pause() } catch (_) { }
    try {
      const a = audioRef.current
      if (a) {
        a.pause()
        a.removeAttribute('src')
        a.load()
      }
    } catch (_) { }
    if (audioPlaybackTimerRef.current) {
      clearTimeout(audioPlaybackTimerRef.current)
      audioPlaybackTimerRef.current = null
    }
    if (audioCtxRef.current) {
      try {
        audioNodesRef.current.forEach((n) => { try { n.stop() } catch (_) { } })
      } catch (_) { }
      try { audioCtxRef.current.close() } catch (_) { }
      audioCtxRef.current = null
    }
    try { mseRef.current.revoke?.() } catch (_) { }
    try { audioMseRef.current.revoke?.() } catch (_) { }
    mseRef.current = { byIndex: {}, revoke: () => { } }
    audioMseRef.current = { sb: null, queue: [], appending: [false], pending: [], revoke: () => { } }
    transitionToIdle()
  }

  const clearChat = () => {
    setChatLog([])
    if (chatKey) {
      try { window.localStorage.removeItem(chatKey) } catch (_) { }
    }
  }

  const handleModeChange = (nextMode) => {
    if (nextMode === mode) return
    // Avoid leaking an audio-mode RTC session into video mode (or vice-versa).
    if (micActive) stopMic()
    stopPlayback()
    setMode(nextMode)
    if (nextMode === 'video') setShowVideoTextInput(false)
  }

  const handleVideoMicToggle = async () => {
    if (micActive) {
      stopMic()
      return
    }
    // Defensive: video mic must always run STT-only session.
    if (audioRtcRef.current?.sttOnly === false) {
      stopMic()
    }
    await startMic({ sttOnly: true })
  }



  const handleReplyEnded = () => {
    setReplyState((prev) => {
      if (prev.queue.length > 0) {
        // Advance to next clip: keep reply layer visible, no gap/flash (next clip is preloaded)
        return { ...prev, current: prev.queue[0], queue: prev.queue.slice(1) }
      }
      // No more clips in queue: only switch to idle when stream is done (avoids speak → idle → speak when clip 1 is still loading)
      if (!prev.streamDone) {
        return prev
      }
      // Stream done and no more clips — transition to idle (clears fallback timers)
      transitionToIdle()
      return prev
    })
  }

  const handleAudioEnded = () => {
    setAudioState((prev) => {
      if (prev.queue.length > 0) {
        return { ...prev, current: prev.queue[0], queue: prev.queue.slice(1) }
      }
      if (!prev.streamDone) {
        return prev
      }
      return { ...prev, current: null }
    })
    setAudioSpeaking(false)
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
        <div className="mode-toggle">
          <span className={`mode-label ${mode === 'audio' ? 'active' : ''}`}>Audio</span>
          <button
            type="button"
            className={`toggle-switch ${mode}`}
            onClick={() => handleModeChange(mode === 'audio' ? 'video' : 'audio')}
            role="switch"
            aria-checked={mode === 'video'}
            disabled={sending}
          >
            <span className="toggle-thumb" />
          </button>
          <span className={`mode-label ${mode === 'video' ? 'active' : ''}`}>Video</span>
        </div>
        <button
          type="button"
          className="clear-btn"
          onClick={clearChat}
          disabled={sending}
        >
          New Chat
        </button>
        <Link to={`/persona/${personaId}/edit`} className="edit-link">Edit</Link>
      </header>
      {mode === 'audio' ? (
        <div className="audio-layout">
          <div className="audio-shell">
            <div className="audio-left">
              {streamError && <p className="stream-error">{streamError}</p>}
              <div className="audio-card audio-persona-card">
                <div className="audio-card-header">
                  <div className="audio-title">{persona?.name || 'Persona'}</div>
                  <div className={`audio-mode-pill ${micActive ? 'live' : ''}`}>
                    {audioSpeaking ? 'Speaking' : micActive ? 'Listening' : 'Idle'}
                  </div>
                </div>
                <div className="audio-poster-stage">
                  {previewUrl && (
                    <img src={previewUrl} alt="" className="audio-poster" />
                  )}
                </div>
              </div>
              <div className="audio-mic-panel">
                <button
                  type="button"
                  className={`mic-btn ${micActive ? 'active' : ''}`}
                  onClick={() => (micActive ? stopMic() : startMic())}
                >
                  {micActive ? 'Mic On' : 'Mic Off'}
                </button>
                <div className="audio-mic-hint">{micActive ? 'Speak now…' : 'Tap to talk'}</div>
                {micError && <p className="stream-error">{micError}</p>}
              </div>
              <audio
                ref={audioRef}
                className="assistant-audio-el"
                onEnded={handleAudioEnded}
                onPlaying={() => {
                  if (perfRef.current.start) {
                    const tPlay = performance.now()
                    const dt = (tPlay - perfRef.current.start) / 1000
                    const dtAfterStart = perfRef.current.audioStart ? (tPlay - perfRef.current.audioStart) / 1000 : null
                    console.info(`[ttfr] audio_playback at ${dt.toFixed(2)}s` + (dtAfterStart != null ? ` (after audio_start ${dtAfterStart.toFixed(2)}s)` : ''))
                  }
                }}
              />
            </div>
            <div className="audio-right">
              <div className="chat-panel">
                <div className="chat-panel-header">
                  <div className="chat-panel-title">Conversation</div>
                  {isGenerating && <div className="audio-status">Thinking...</div>}
                </div>
                <div className="chat-log" ref={chatLogScrollRef}>
                  {chatLog.map((m, i) => (
                    <div key={`${m.role}-${i}`} className={`chat-msg ${m.role}`}>
                      <span className="chat-role">{m.role === 'user' ? 'You' : persona.name}</span>
                      <span className="chat-text">{m.text}</span>
                    </div>
                  ))}
                </div>
                <div className="audio-input-wrap">
                  <form onSubmit={sendMessage} className="input-form">
                    <input
                      type="text"
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      placeholder="Type a message…"
                      disabled={sending}
                    />
                    <button type="submit" disabled={sending || !input.trim()}>Send</button>
                    <button
                      type="button"
                      className="stop-btn"
                      onClick={stopPlayback}
                      disabled={!canStop}
                    >
                      Stop
                    </button>
                  </form>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="audio-layout video-layout">
          <div className="audio-shell">
            <div className="audio-left">
              {streamError && <p className="stream-error">{streamError}</p>}
              <div className="audio-card video-persona-card">
                <div className="audio-card-header">
                  <div className="audio-title">{persona?.name || 'Persona'}</div>
                  <div className="audio-mode-pill audio-mode-pill-video">Video</div>
                </div>
                <div className="video-card-stage">
                  <div className="video-wrap">
                    {isGenerating && (
                      <div className="streaming-status generating">Thinking...</div>
                    )}
                    {isStreaming && !isGenerating && replyState.queue.length > 0 && (
                      <div className="streaming-status next">Next clip ready</div>
                    )}
                    {previewUrl && !showReply && (
                      <img
                        src={previewUrl}
                        alt=""
                        className="video-layer poster-fallback"
                        style={{ opacity: idlePlaying && !idleVideoError ? 0 : 1 }}
                      />
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
                      style={{ opacity: 1 }}
                      onError={() => setIdleVideoError(true)}
                      onPlaying={() => {
                        setIdlePlaying(true)
                        if (clearReplyPendingRef.current) {
                          clearReplyPendingRef.current = false
                          setShowReply(false)
                        }
                      }}
                      onPause={() => {
                        setIdlePlaying(false)
                        idleVideoRef.current?.play().catch(() => { })
                      }}
                      onWaiting={() => setIdlePlaying(false)}
                      onTimeUpdate={() => {
                        if (!idlePlaying) setIdlePlaying(true)
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
                        setShowReply(true)
                        if (perfRef.current.start) {
                          const tPlay = performance.now()
                          const dt = (tPlay - perfRef.current.start) / 1000
                          const dtAfterVideoStart = perfRef.current.videoStart ? (tPlay - perfRef.current.videoStart) / 1000 : null
                          console.info(`[ttfr] UI playback at ${dt.toFixed(2)}s` + (dtAfterVideoStart != null ? ` (after video_start ${dtAfterVideoStart.toFixed(2)}s)` : ''))
                        }
                      }}
                      onCanPlay={() => {
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
                      onProgress={() => {
                        if (isVideoMseAvailable() && mode === 'video') resumeReplyPlayback()
                      }}
                      onEnded={handleReplyEnded}
                      onWaiting={() => {
                        if (stallTimeoutRef.current) clearTimeout(stallTimeoutRef.current);
                        stallTimeoutRef.current = setTimeout(() => {
                          resumeReplyPlayback()
                          stallTimeoutRef.current = null;
                        }, 500);

                        if (isVideoMseAvailable() && modeRef.current === 'video' && !gotFirstClipRef.current) {
                          return
                        }

                        if (longWaitTimeoutRef.current) clearTimeout(longWaitTimeoutRef.current);
                        longWaitTimeoutRef.current = setTimeout(() => {
                          setSending(false);
                          transitionToIdle();
                        }, 10000);
                      }}
                      onStalled={() => {
                        resumeReplyPlayback()
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
                </div>
              </div>
              <div className="audio-mic-panel">
                <button
                  type="button"
                  className={`mic-btn ${micActive ? 'active' : ''}`}
                  onClick={handleVideoMicToggle}
                  disabled={sending}
                >
                  {micActive ? 'Mic On' : 'Mic Off'}
                </button>
                <div className="audio-mic-hint">{micActive ? 'Speak now…' : 'Tap to talk'}</div>
                {micError && <p className="stream-error">{micError}</p>}
              </div>
            </div>
            <div className="audio-right">
              <div className="chat-panel video-chat-panel">
                <div className="chat-panel-header">
                  <div className="chat-panel-title">Conversation</div>
                  {isGenerating && <div className="audio-status">Thinking...</div>}
                </div>
                <div className="chat-log" ref={chatLogScrollRef}>
                  {chatLog.map((m, i) => (
                    <div key={`${m.role}-${i}`} className={`chat-msg ${m.role}`}>
                      <span className="chat-role">{m.role === 'user' ? 'You' : persona.name}</span>
                      <span className="chat-text">{m.text}</span>
                    </div>
                  ))}
                </div>
                <div className="audio-input-wrap video-input-wrap">
                  <div className="video-text-toggle-wrap">
                    <button
                      type="button"
                      className="video-text-toggle"
                      onClick={() => setShowVideoTextInput((v) => !v)}
                    >
                      {showVideoTextInput ? 'Hide text input' : 'Type a message instead'}
                    </button>
                  </div>
                  <form onSubmit={sendMessage} className="input-form">
                    {showVideoTextInput && (
                      <input
                        type="text"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        placeholder={micActive ? 'Turn off mic to type…' : 'Type a message…'}
                        disabled={sending || micActive}
                      />
                    )}
                    {showVideoTextInput && (
                      <button type="submit" disabled={sending || micActive || !input.trim()}>Send</button>
                    )}
                    <button type="button" className="stop-btn" onClick={stopPlayback} disabled={!canStop}>
                      Stop
                    </button>
                  </form>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      <style>{`
        .conv { position: fixed; inset: 0; display: flex; flex-direction: column; background: #000; color: #e4e4e7; }
        .conv a { color: #a78bfa; }
        .conv-header { position: relative; z-index: 20; flex-shrink: 0; padding: 0.5rem 0.75rem; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; background: rgba(0,0,0,0.85); border-bottom: 1px solid rgba(255,255,255,0.1); }
        .conv-header a { margin-right: 0; color: #a78bfa; }
        .conv h1 { font-family: var(--font-heading); font-size: 0.95rem; font-weight: 600; margin: 0; flex: 1; color: #fff; }
        .conv-header .edit-link { color: #a78bfa; font-size: 0.85rem; }
        .assistant-audio-el { position: absolute; width: 0; height: 0; opacity: 0; pointer-events: none; }
        .audio-layout { display: grid; grid-template-columns: 1fr; padding: 1.25rem; flex: 1; min-height: 0; background: radial-gradient(1200px 400px at 20% 0%, rgba(59,130,246,0.12), transparent 60%), radial-gradient(800px 500px at 80% 10%, rgba(16,185,129,0.12), transparent 55%); }
        .video-layout { background: radial-gradient(1200px 400px at 20% 0%, rgba(16,185,129,0.1), transparent 60%), radial-gradient(800px 500px at 80% 10%, rgba(59,130,246,0.08), transparent 55%); }
        .audio-shell { display: grid; grid-template-columns: 1.05fr 0.95fr; gap: 1.5rem; min-height: 0; }
        .audio-left { display: flex; flex-direction: column; gap: 1rem; min-width: 0; min-height: 0; height: 100%; }
        .audio-right { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
        .audio-card { border-radius: 18px; padding: 1rem; background: rgba(15,23,42,0.75); border: 1px solid rgba(148,163,184,0.2); box-shadow: 0 24px 60px rgba(0,0,0,0.35); display: flex; flex-direction: column; min-height: 0; }
        .audio-persona-card,
        .video-persona-card { flex: 1; min-height: 0; }
        .audio-poster-stage { position: relative; flex: 1; min-height: min(52vh, 420px); width: 100%; border-radius: 14px; overflow: hidden; background: #0b0f17; border: 1px solid rgba(148,163,184,0.2); }
        .audio-poster-stage .audio-poster { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #0b0f17; }
        .video-card-stage { position: relative; flex: 1; min-height: min(52vh, 420px); width: 100%; border-radius: 14px; overflow: hidden; background: #000; border: 1px solid rgba(148,163,184,0.15); }
        .video-layout .video-card-stage { border-color: rgba(16,185,129,0.35); }
        .video-card-stage .video-wrap { position: absolute; inset: 0; z-index: 0; flex: none; min-height: 0; width: 100%; height: 100%; background: #000; overflow: hidden; pointer-events: none; }
        .video-wrap .video-layer { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; transition: opacity 0.35s ease-out; pointer-events: none; }
        .video-wrap .video-layer.poster-fallback { z-index: 2; }
        .video-wrap .video-layer.reply-layer { z-index: 1; transition: opacity 0.3s ease-in-out; }
        .video-wrap .video-layer.reply-layer.reply-hiding { transition: opacity 0.35s ease-out; }
        .audio-card-header { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; margin-bottom: 0.75rem; flex-shrink: 0; }
        .audio-title { font-size: 1.05rem; font-weight: 600; color: #fff; }
        .audio-mode-pill { font-size: 0.7rem; padding: 0.25rem 0.6rem; border-radius: 999px; text-transform: uppercase; letter-spacing: 0.08em; background: rgba(148,163,184,0.2); color: rgba(255,255,255,0.8); }
        .audio-mode-pill.live { background: rgba(16,185,129,0.25); color: #a7f3d0; }
        .audio-mode-pill-video { background: rgba(16,185,129,0.22); color: #a7f3d0; border: 1px solid rgba(16,185,129,0.4); }
        .audio-mic-panel { display: flex; flex-direction: column; gap: 0.35rem; align-items: flex-start; padding: 0.75rem 0.85rem; border-radius: 16px; border: 1px solid rgba(148,163,184,0.2); background: rgba(2,6,23,0.6); }
        .audio-mic-hint { font-size: 0.78rem; color: rgba(148,163,184,0.9); }
        .audio-status { font-size: 0.78rem; color: rgba(148,163,184,0.9); }
        .chat-panel { display: flex; flex-direction: column; min-height: 0; height: 100%; background: rgba(8,11,18,0.75); border: 1px solid rgba(148,163,184,0.2); border-radius: 18px; box-shadow: 0 20px 50px rgba(0,0,0,0.35); overflow: hidden; }
        .video-chat-panel { border-color: rgba(16,185,129,0.28); }
        .chat-panel-header { display: flex; align-items: center; justify-content: space-between; padding: 0.85rem 1rem; border-bottom: 1px solid rgba(148,163,184,0.2); }
        .chat-panel-title { font-size: 0.9rem; font-weight: 600; color: rgba(255,255,255,0.9); }
        .chat-log { display: flex; flex-direction: column; gap: 0.6rem; flex: 1; overflow-y: auto; padding: 0.9rem 1rem; }
        .video-input-wrap .video-text-toggle-wrap { padding: 0 0 0.35rem; }
        .video-text-toggle { background: none; border: none; color: #a78bfa; font-size: 0.78rem; cursor: pointer; text-decoration: underline; padding: 0.15rem 0; }
        .video-text-toggle:hover { color: #c4b5fd; }
        .audio-input-wrap { padding: 0.75rem 1rem 1rem; border-top: 1px solid rgba(148,163,184,0.2); background: rgba(2,6,23,0.55); }
        .audio-input-wrap .input-form { background: rgba(15,23,42,0.6); border: 1px solid rgba(148,163,184,0.2); border-radius: 14px; padding: 0.5rem; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
        .audio-input-wrap .input-form input { flex: 1; background: transparent; border: none; padding: 0.6rem 0.75rem; min-width: 220px; color: #fff; }
        .audio-input-wrap .input-form input:focus { outline: none; }
        .audio-input-wrap .input-form button[type="submit"] { padding: 0.6rem 1rem; border-radius: var(--radius); border: none; background: var(--primary); color: #fff; font-weight: 500; cursor: pointer; }
        .audio-input-wrap .input-form button[type="submit"]:hover:not(:disabled) { background: var(--primary-hover); }
        .audio-input-wrap .input-form button[type="submit"]:disabled { opacity: 0.5; cursor: not-allowed; }
        .input-form { display: flex; gap: 0.5rem; padding: 0.75rem 1rem; width: 100%; }
        .input-form input { flex: 1; padding: 0.6rem 0.75rem; border-radius: var(--radius); border: 1px solid rgba(255,255,255,0.2); background: rgba(255,255,255,0.08); color: #fff; }
        .input-form input::placeholder { color: rgba(255,255,255,0.5); }
        .input-form input:focus { outline: none; border-color: var(--primary); }
        .input-form button[type="submit"] { padding: 0.6rem 1rem; border-radius: var(--radius); border: none; background: var(--primary); color: #fff; font-weight: 500; cursor: pointer; }
        .input-form button[type="submit"]:hover:not(:disabled) { background: var(--primary-hover); }
        .input-form button[type="submit"]:disabled { opacity: 0.5; cursor: not-allowed; }
        .stream-error { color: #f87171; font-size: 0.85rem; padding: 0 1rem; margin: 0 0 0.25rem; }
        .streaming-status { position: absolute; bottom: 0.75rem; left: 50%; transform: translateX(-50%); z-index: 3; padding: 0.35rem 0.75rem; border-radius: 999px; font-size: 0.8rem; background: rgba(0,0,0,0.75); color: rgba(255,255,255,0.9); pointer-events: none; }
        .streaming-status.generating { animation: pulse 1.5s ease-in-out infinite; }
        .streaming-status.next { opacity: 0.85; }
        .mode-toggle { display: flex; align-items: center; gap: 0.45rem; }
        .mode-label { font-size: 0.75rem; letter-spacing: 0.04em; text-transform: uppercase; color: rgba(255,255,255,0.6); }
        .mode-label.active { color: #fff; }
        .toggle-switch { position: relative; width: 46px; height: 24px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.2); background: rgba(255,255,255,0.08); cursor: pointer; padding: 0; }
        .toggle-switch.audio { background: rgba(59,130,246,0.25); border-color: rgba(59,130,246,0.6); }
        .toggle-switch.video { background: rgba(16,185,129,0.25); border-color: rgba(16,185,129,0.6); }
        .toggle-switch:disabled { opacity: 0.5; cursor: not-allowed; }
        .toggle-thumb { position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 999px; background: #fff; transition: transform 0.2s ease; }
        .toggle-switch.video .toggle-thumb { transform: translateX(22px); }
        .mic-btn { border: 1px solid rgba(255,255,255,0.2); background: rgba(59,130,246,0.15); color: #fff; padding: 0.6rem 0.9rem; border-radius: var(--radius); cursor: pointer; }
        .mic-btn.active { background: rgba(16,185,129,0.2); border-color: rgba(16,185,129,0.6); }
        .stop-btn { border: 1px solid rgba(255,255,255,0.2); background: rgba(239,68,68,0.15); color: #fff; padding: 0.6rem 1rem; border-radius: var(--radius); cursor: pointer; }
        .stop-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .clear-btn { border: 1px solid rgba(255,255,255,0.2); background: rgba(59,130,246,0.15); color: #fff; padding: 0.25rem 0.6rem; border-radius: 999px; cursor: pointer; }
        .clear-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .chat-msg { display: flex; flex-direction: column; gap: 0.2rem; padding: 0.6rem 0.8rem; border-radius: 14px; background: rgba(255,255,255,0.06); }
        .chat-msg.user { align-self: flex-end; background: rgba(59,130,246,0.15); }
        .chat-role { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; }
        .chat-text { font-size: 0.9rem; }
        @media (max-width: 980px) {
          .audio-shell { grid-template-columns: 1fr; }
        }
        @media (max-width: 720px) {
          .audio-layout {
            padding: 0.75rem;
            display: flex;
            flex-direction: column;
            flex: 1;
            min-height: 0;
          }
          .audio-shell {
            display: flex;
            flex-direction: column;
            flex: 1;
            min-height: 0;
            gap: 0.75rem;
          }
          .audio-right {
            display: none;
          }
          .chat-panel { display: none; }
          .audio-left {
            flex: 1;
            min-height: 0;
            gap: 0.75rem;
            justify-content: flex-start;
            height: auto;
          }
          .audio-card { padding: 0.85rem; }
          .audio-card-header { flex-direction: column; align-items: flex-start; }
          .audio-layout .audio-persona-card,
          .video-layout .video-persona-card {
            flex: 1 1 auto;
            min-height: 0;
          }
          .audio-poster-stage,
          .video-card-stage {
            flex: 1;
            min-height: min(36vh, 260px);
          }
          .audio-mic-panel {
            flex-shrink: 0;
            align-self: stretch;
            align-items: flex-end;
            flex-direction: column;
            width: 100%;
            margin-top: 0;
          }
          .audio-mic-panel .mic-btn {
            align-self: flex-end;
          }
          .audio-mic-panel .audio-mic-hint {
            text-align: right;
            align-self: flex-end;
            max-width: 100%;
          }
          .audio-input-wrap { padding: 0.5rem; border-radius: 16px; border: 1px solid rgba(148,163,184,0.2); background: rgba(2,6,23,0.7); }
          .audio-input-wrap .input-form { padding: 0.4rem; }
          .audio-input-wrap .input-form input { width: 100%; min-width: 0; }
          .audio-input-wrap .input-form button { flex: 1; }
          .mic-btn, .stop-btn { padding: 0.55rem 0.75rem; }
        }
        @keyframes pulse { 50% { opacity: 0.7; } }
      `}</style>
    </div>
  )
}
