import { useParams, Link, useNavigate } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import { apiFetch, getToken } from '../auth'

const API = '/api'
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
  const navigate = useNavigate()
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
  /** WebRTC voice session is up (until end chat, leave page, or mode switch). */
  const [micActive, setMicActive] = useState(false)
  /** When session is up: actually send mic audio for STT (false = muted, connection stays open). */
  const [micListening, setMicListening] = useState(false)
  const [audioSpeaking, setAudioSpeaking] = useState(false)
  const [micError, setMicError] = useState(null)
  /** Video mode: voice-first UI; text field revealed on demand. */
  const [showVideoTextInput, setShowVideoTextInput] = useState(false)
  /** Video mode: right-hand chat panel (reference layout). */
  const [showChatPanel, setShowChatPanel] = useState(true)
  /** Floating bar: mode + actions (Audio / Avatar dropdown). */
  const [barMenuOpen, setBarMenuOpen] = useState(false)
  const waveCanvasRef = useRef(null)
  const waveWrapRef = useRef(null)
  const waveRafRef = useRef(null)
  const micAnalyserRef = useRef(null)
  const micVizCtxRef = useRef(null)
  const micVizSourceRef = useRef(null)
  const micVizStreamRef = useRef(null)
  const micActiveRef = useRef(false)
  const micListeningRef = useRef(false)
  const audioSpeakingRef = useRef(false)
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
  const chatLogScrollRef = useRef(null)
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
  const integrationBlocked = !!(persona && persona.integration_ready === false)
  const integrationMessage =
    (persona && typeof persona.integration_message === 'string' && persona.integration_message.trim()) || ''

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

  // Always keep conversation pinned to the latest message.
  useEffect(() => {
    const el = chatLogScrollRef.current
    if (!el) return
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
  }, [chatLog, mode, personaId])

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
  const CODECS = 'video/mp4; codecs="avc1.42401E,mp4a.40.2"'
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
      // Streaming Ditto: fMP4 arrives on the WebSocket as binary; this event is metadata only.
      if (data?.streaming !== false) return
      // Non-streaming Ditto: play the MP4 URL instead of an empty MediaSource.
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
        const tt = String(overrideText).trim()
        if (tt) {
          setChatLog((prev) => [...prev, { role: 'user', text: tt }])
        }
        setStreamError('Wait for the current reply to finish, then speak again.')
      }
      return
    }
    // Typing is blocked while actively listening; STT uses sendMessage(null, transcript) with session still open.
    if (micListening && overrideText == null) {
      setStreamError('Mute the mic to type a message.')
      return
    }
    if (integrationBlocked) {
      setStreamError(
        integrationMessage ||
          'This persona is incomplete or linked services no longer have its voice or face. Delete it and create a new one, or fix it in Edit persona.'
      )
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

    if (modeRef.current === 'video') {
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
          const sb = ms.addSourceBuffer(CODECS)
          sb.mode = 'sequence'
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

  const disposeMicWave = () => {
    try {
      micVizSourceRef.current?.disconnect()
    } catch (_) { }
    micVizSourceRef.current = null
    micAnalyserRef.current = null
    try {
      micVizStreamRef.current?.getTracks().forEach((t) => t.stop())
    } catch (_) { }
    micVizStreamRef.current = null
    try {
      micVizCtxRef.current?.close()
    } catch (_) { }
    micVizCtxRef.current = null
  }

  const stopMic = () => {
    disposeMicWave()
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
    micActiveRef.current = false
    micListeningRef.current = false
    setMicListening(false)
    setMicActive(false)
  }

  const toggleMicListening = () => {
    const curr = audioRtcRef.current
    const track = curr.stream?.getAudioTracks?.()?.[0]
    if (!track || !curr.pc) return
    const next = !micListeningRef.current
    track.enabled = next
    try {
      if (curr.dc && curr.dc.readyState === 'open') {
        curr.dc.send(JSON.stringify({ event: next ? 'mic_resume' : 'mic_pause' }))
      }
    } catch (_) { }
    micListeningRef.current = next
    setMicListening(next)
  }

  const startMic = async ({ sttOnly = null } = {}) => {
    if (!personaId || micActive) return
    if (persona && persona.integration_ready === false) {
      const msg =
        (typeof persona.integration_message === 'string' && persona.integration_message.trim()) ||
        'This persona is incomplete. Fix it in Edit persona or delete and recreate before using the mic.'
      setMicError(msg)
      setStreamError(msg)
      return
    }
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
      if (!resolvedSttOnly) {
        try {
          disposeMicWave()
          const clone = stream.clone()
          micVizStreamRef.current = clone
          const VizCtx = window.AudioContext || window.webkitAudioContext
          const vctx = new VizCtx()
          await vctx.resume().catch(() => { })
          micVizCtxRef.current = vctx
          const src = vctx.createMediaStreamSource(clone)
          micVizSourceRef.current = src
          const analyser = vctx.createAnalyser()
          analyser.fftSize = 512
          analyser.smoothingTimeConstant = 0.62
          src.connect(analyser)
          micAnalyserRef.current = analyser
        } catch (e) {
          console.warn('[wave] mic analyser setup failed', e)
        }
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
          } else if (msg.event === 'error' && msg.data && msg.data.error) {
            const errText = String(msg.data.error)
            setMicError(errText)
            setStreamError(errText)
            stopMic()
          }
        } catch (_) { }
      }
      ws.onclose = () => {
        console.warn('[audio] ws closed')
        if (micActiveRef.current) stopMic()
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
      micActiveRef.current = true
      micListeningRef.current = true
      setMicActive(true)
      setMicListening(true)
    } catch (e) {
      setMicError(e?.message || 'Could not access microphone')
      console.error('[audio] startMic failed', e)
      stopMic()
    }
  }

  useEffect(() => () => stopMic(), [])

  useEffect(() => {
    if (!barMenuOpen) return
    const close = (e) => {
      if (!e.target.closest?.('.vf-bar-menu-wrap')) setBarMenuOpen(false)
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [barMenuOpen])

  useEffect(() => {
    if (mode !== 'audio') {
      if (waveRafRef.current) {
        cancelAnimationFrame(waveRafRef.current)
        waveRafRef.current = null
      }
      return
    }
    const canvas = waveCanvasRef.current
    const wrap = waveWrapRef.current
    if (!canvas || !wrap) return
    const ctx2d = canvas.getContext('2d')
    if (!ctx2d) return
    const freq = new Uint8Array(256)
    let t = 0
    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      const r = wrap.getBoundingClientRect()
      const w = Math.max(280, Math.floor(r.width))
      const h = Math.max(200, Math.floor(r.height))
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null
    ro?.observe(wrap)
    const nBars = 80
    const draw = () => {
        const r = wrap.getBoundingClientRect()
        const cw = Math.max(280, r.width)
        const ch = Math.max(200, r.height)
        ctx2d.clearRect(0, 0, cw, ch)
        const baseY = ch * 0.58
        const micOn = micListeningRef.current && !!micAnalyserRef.current
        const speaking = audioSpeakingRef.current
        const analyser = micAnalyserRef.current
        if (micOn && analyser) analyser.getByteFrequencyData(freq)
        t += 0.042
        const grad = ctx2d.createLinearGradient(0, 0, cw, 0)
        grad.addColorStop(0, 'rgba(124, 58, 237, 0.35)')
        grad.addColorStop(0.5, 'rgba(168, 85, 247, 0.55)')
        grad.addColorStop(1, 'rgba(59, 130, 246, 0.35)')
        ctx2d.fillStyle = grad
        const hw = cw / nBars
        for (let i = 0; i < nBars; i++) {
          const x = i * hw + hw * 0.18
          const wBar = hw * 0.64
          let mag = 0
          if (micOn) {
            const step = Math.max(1, Math.floor(freq.length / nBars))
            let acc = 0
            for (let j = 0; j < step; j++) acc += freq[i * step + j] || 0
            mag = (acc / step / 255) ** 1.15
          } else {
            const phase = t + i * 0.09
            const idle = 0.08 + Math.sin(phase) * 0.05 + Math.sin(phase * 1.7 + i * 0.2) * 0.04
            mag = speaking ? Math.min(0.95, idle + 0.35 + Math.sin(phase * 2.2) * 0.12) : idle
          }
          const maxH = ch * 0.42
          const hBar = Math.max(4, mag * maxH)
          const y = baseY - hBar
          ctx2d.fillRect(x, y, wBar, hBar)
        }
        waveRafRef.current = requestAnimationFrame(draw)
      }
    waveRafRef.current = requestAnimationFrame(draw)
    return () => {
      ro?.disconnect()
      if (waveRafRef.current) {
        cancelAnimationFrame(waveRafRef.current)
        waveRafRef.current = null
      }
    }
  }, [mode])

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
    setBarMenuOpen(false)
    // Avoid leaking an audio-mode RTC session into video mode (or vice-versa).
    if (micActive) stopMic()
    stopPlayback()
    setMode(nextMode)
    if (nextMode === 'video') setShowVideoTextInput(false)
  }

  const handleVideoMicToggle = async () => {
    if (micActive) {
      toggleMicListening()
      return
    }
    // Defensive: video mic must always run STT-only session.
    if (audioRtcRef.current?.sttOnly === false) {
      stopMic()
    }
    await startMic({ sttOnly: true })
  }

  const handleEndChat = () => {
    stopMic()
    stopPlayback()
    navigate('/app')
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

  micActiveRef.current = micActive
  micListeningRef.current = micListening
  audioSpeakingRef.current = audioSpeaking

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
      <header className={`conv-header ${mode === 'audio' ? 'conv-header-light' : ''}`}>
        <Link to="/app">← Back</Link>
        <h1 className="conv-header-title">{persona.name}</h1>
        <Link to={`/persona/${personaId}/edit`} className="edit-link">Edit</Link>
      </header>
      {integrationBlocked && (
        <div className="integration-banner" role="alert">
          <p className="integration-banner-text">
            {integrationMessage ||
              'This persona is incomplete or linked services (voice / video) no longer have its data. Delete this persona and create a new one, or open Edit to re-upload voice or face.'}
          </p>
          <p className="integration-banner-actions">
            <Link to={`/persona/${personaId}/edit`}>Edit persona</Link>
            <span aria-hidden="true"> · </span>
            <Link to="/app">Back to list</Link>
          </p>
        </div>
      )}
      {mode === 'video' ? (
      <div className="video-stage-layout">
        <div className="video-stage-main">
          <div className="video-wrap" aria-hidden="true">
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
                if (mode === 'video') resumeReplyPlayback()
              }}
              onEnded={handleReplyEnded}
              onWaiting={() => {
                if (stallTimeoutRef.current) clearTimeout(stallTimeoutRef.current);
                stallTimeoutRef.current = setTimeout(() => {
                  resumeReplyPlayback()
                  stallTimeoutRef.current = null;
                }, 500);

                if (modeRef.current === 'video' && !gotFirstClipRef.current) {
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

          <div className="video-floating-bar" role="toolbar" aria-label="Conversation controls">
            <div className="video-floating-bar-inner">
              <div className="vf-bar-menu-wrap">
                <button
                  type="button"
                  className="vf-persona-btn"
                  aria-expanded={barMenuOpen}
                  aria-haspopup="menu"
                  onClick={(e) => {
                    e.stopPropagation()
                    setBarMenuOpen((o) => !o)
                  }}
                >
                  <span className="vf-persona-label">Avatar</span>
                  <span className="vf-chevron" aria-hidden>▾</span>
                </button>
                {barMenuOpen && (
                  <div className="vf-persona-menu" role="menu" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      role="menuitem"
                      className={mode === 'video' ? 'vf-menu-current' : ''}
                      aria-current={mode === 'video' ? 'true' : undefined}
                      onClick={() => { setBarMenuOpen(false); handleModeChange('video') }}
                    >
                      Avatar (video)
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className={mode === 'audio' ? 'vf-menu-current' : ''}
                      aria-current={mode === 'audio' ? 'true' : undefined}
                      onClick={() => { setBarMenuOpen(false); handleModeChange('audio') }}
                    >
                      Audio
                    </button>
                  </div>
                )}
              </div>
              <button
                type="button"
                className={`vf-icon-btn ${micListening ? 'vf-on' : ''} ${micActive && !micListening ? 'vf-muted' : ''}`}
                onClick={handleVideoMicToggle}
                disabled={sending || (!micActive && integrationBlocked)}
                aria-label={
                  !micActive
                    ? 'Start voice session'
                    : micListening
                      ? 'Mute microphone (stay connected)'
                      : 'Unmute microphone'
                }
                title={
                  !micActive
                    ? 'Tap to speak — opens voice connection'
                    : micListening
                      ? 'Listening — tap to mute (connection stays open)'
                      : 'Muted — tap to listen again'
                }
              >
                {!micActive ? (
                  <svg className="vf-svg" viewBox="0 0 24 24" aria-hidden>
                    <path fill="currentColor" d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" />
                  </svg>
                ) : micListening ? (
                  <svg className="vf-svg" viewBox="0 0 24 24" aria-hidden>
                    <path fill="currentColor" d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z" />
                  </svg>
                ) : (
                  <svg className="vf-svg" viewBox="0 0 24 24" aria-hidden>
                    <path fill="currentColor" d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" />
                  </svg>
                )}
              </button>
              <button
                type="button"
                className={`vf-icon-btn ${showChatPanel ? 'vf-on' : ''}`}
                onClick={() => setShowChatPanel((v) => !v)}
                aria-pressed={showChatPanel}
                aria-label={showChatPanel ? 'Hide chat panel' : 'Show chat panel'}
                title="Chat"
              >
                <svg className="vf-svg" viewBox="0 0 24 24" aria-hidden>
                  <path fill="currentColor" d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z" />
                </svg>
              </button>
              <button type="button" className="vf-end-chat" onClick={handleEndChat}>
                <svg className="vf-svg vf-end-icon" viewBox="0 0 24 24" aria-hidden>
                  <path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                </svg>
                <span>End chat</span>
              </button>
            </div>
          </div>
        </div>

        <aside className={`video-chat-drawer ${showChatPanel ? 'open' : 'collapsed'}`} aria-hidden={!showChatPanel}>
          <div className="video-chat-drawer-head">
            <button
              type="button"
              className="video-chat-collapse"
              onClick={() => setShowChatPanel(false)}
              aria-label="Hide chat panel"
              title="Hide chat"
            >
              <svg className="vf-svg" viewBox="0 0 24 24" aria-hidden><path fill="currentColor" d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" /></svg>
            </button>
            <span className="video-chat-title">{persona.name}</span>
          </div>
          <div className="video-chat-sub">Voice + talking head · messages also appear here</div>
          <div className="video-chat-log video-chat-log-light" ref={chatLogScrollRef}>
            {isGenerating && (
              <div className="video-chat-thinking">Thinking…</div>
            )}
            {chatLog.map((m, i) => (
              <div key={`${m.role}-${i}`} className={`video-chat-row ${m.role}`}>
                {m.role === 'assistant' && (
                  previewUrl ? (
                    <img src={previewUrl} alt="" className="video-chat-avatar" width={32} height={32} />
                  ) : (
                    <span className="video-chat-avatar video-chat-avatar-fallback" aria-hidden>{(persona.name || '?').slice(0, 1)}</span>
                  )
                )}
                <div className={`video-chat-bubble ${m.role}`}>
                  <span className="video-chat-bubble-text">{m.text}{m.streaming ? '…' : ''}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="video-chat-footer">
            {streamError && <p className="video-chat-error">{streamError}</p>}
            {micError && <p className="video-chat-error">{micError}</p>}
            <p className="video-chat-hint">
              {!micActive
                ? 'Use the mic button on the video bar, or type below.'
                : micListening
                  ? 'Speak naturally — pause briefly so your line is sent.'
                  : 'Mic muted — connection stays open. Unmute to speak, or type below.'}
            </p>
            <button
              type="button"
              className="video-chat-type-toggle"
              onClick={() => setShowVideoTextInput((v) => !v)}
            >
              {showVideoTextInput ? 'Hide keyboard' : 'Type a message'}
            </button>
            {showVideoTextInput && (
              <form onSubmit={sendMessage} className="video-chat-form">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={micListening ? 'Mute mic to type…' : 'Message…'}
                  disabled={sending || micListening || integrationBlocked}
                />
                <button type="submit" disabled={sending || micListening || !input.trim() || integrationBlocked}>Send</button>
              </form>
            )}
            <div className="video-chat-footer-actions">
              <button type="button" className="video-chat-stop" onClick={stopPlayback} disabled={!canStop}>Stop reply</button>
            </div>
          </div>
        </aside>
      </div>
      ) : (
        <div className="audio-stage-layout">
          <div className="audio-stage-main">
            <div className={`audio-wave-wrap${isGenerating ? ' audio-wave-wrap-thinking' : ''}`} ref={waveWrapRef}>
              <div className="audio-wave-glow" aria-hidden />
              {isGenerating && (
                <div className="audio-wave-thinking" aria-live="polite">Thinking…</div>
              )}
              <canvas ref={waveCanvasRef} className="audio-wave-canvas" aria-label="Audio level visualizer" />
              <div className="audio-wave-status" aria-live="polite">
                {audioSpeaking ? 'Speaking' : micListening ? 'Listening' : micActive ? 'Muted' : 'Ready'}
              </div>
            </div>
            <audio
              ref={audioRef}
              className="audio-hidden-element"
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

            <div className="audio-floating-bar" role="toolbar" aria-label="Audio conversation controls">
              <div className="audio-floating-bar-inner">
                <div className="vf-bar-menu-wrap">
                  <button
                    type="button"
                    className="vf-persona-btn"
                    aria-expanded={barMenuOpen}
                    aria-haspopup="menu"
                    onClick={(e) => {
                      e.stopPropagation()
                      setBarMenuOpen((o) => !o)
                    }}
                  >
                    <span className="vf-persona-label">Audio</span>
                    <span className="vf-chevron" aria-hidden>▾</span>
                  </button>
                  {barMenuOpen && (
                    <div className="vf-persona-menu" role="menu" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        role="menuitem"
                        className={mode === 'video' ? 'vf-menu-current' : ''}
                        aria-current={mode === 'video' ? 'true' : undefined}
                        onClick={() => { setBarMenuOpen(false); handleModeChange('video') }}
                      >
                        Avatar (video)
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className={mode === 'audio' ? 'vf-menu-current' : ''}
                        aria-current={mode === 'audio' ? 'true' : undefined}
                        onClick={() => { setBarMenuOpen(false); handleModeChange('audio') }}
                      >
                        Audio
                      </button>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className={`vf-icon-btn ${micListening ? 'vf-on' : ''} ${micActive && !micListening ? 'vf-muted' : ''}`}
                  onClick={() => (micActive ? toggleMicListening() : startMic())}
                  disabled={!micActive && integrationBlocked}
                  aria-label={
                    !micActive
                      ? 'Start voice session'
                      : micListening
                        ? 'Mute microphone (stay connected)'
                        : 'Unmute microphone'
                  }
                  title={
                    !micActive
                      ? 'Tap to speak — opens voice connection'
                      : micListening
                        ? 'Listening — tap to mute (connection stays open)'
                        : 'Muted — tap to listen again'
                  }
                >
                  {!micActive ? (
                    <svg className="vf-svg" viewBox="0 0 24 24" aria-hidden>
                      <path fill="currentColor" d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" />
                    </svg>
                  ) : micListening ? (
                    <svg className="vf-svg" viewBox="0 0 24 24" aria-hidden>
                      <path fill="currentColor" d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z" />
                    </svg>
                  ) : (
                    <svg className="vf-svg" viewBox="0 0 24 24" aria-hidden>
                      <path fill="currentColor" d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" />
                    </svg>
                  )}
                </button>
                <button
                  type="button"
                  className={`vf-icon-btn ${showChatPanel ? 'vf-on' : ''}`}
                  onClick={() => setShowChatPanel((v) => !v)}
                  aria-pressed={showChatPanel}
                  aria-label={showChatPanel ? 'Hide chat panel' : 'Show chat panel'}
                  title="Chat"
                >
                  <svg className="vf-svg" viewBox="0 0 24 24" aria-hidden>
                    <path fill="currentColor" d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z" />
                  </svg>
                </button>
                <button type="button" className="vf-end-chat" onClick={handleEndChat}>
                  <svg className="vf-svg vf-end-icon" viewBox="0 0 24 24" aria-hidden>
                    <path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                  </svg>
                  <span>End chat</span>
                </button>
              </div>
            </div>
          </div>

          <aside className={`video-chat-drawer ${showChatPanel ? 'open' : 'collapsed'}`} aria-hidden={!showChatPanel}>
            <div className="video-chat-drawer-head">
              <button
                type="button"
                className="video-chat-collapse"
                onClick={() => setShowChatPanel(false)}
                aria-label="Hide chat panel"
                title="Hide chat"
              >
                <svg className="vf-svg" viewBox="0 0 24 24" aria-hidden><path fill="currentColor" d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" /></svg>
              </button>
              <span className="video-chat-title">{persona.name}</span>
            </div>
            <div className="video-chat-sub">Voice conversation · live audio with optional typing</div>
            <div className="video-chat-log video-chat-log-light" ref={chatLogScrollRef}>
              {isGenerating && (
                <div className="video-chat-thinking">Thinking…</div>
              )}
              {chatLog.map((m, i) => (
                <div key={`${m.role}-${i}`} className={`video-chat-row ${m.role}`}>
                  {m.role === 'assistant' && (
                    previewUrl ? (
                      <img src={previewUrl} alt="" className="video-chat-avatar" width={32} height={32} />
                    ) : (
                      <span className="video-chat-avatar video-chat-avatar-fallback" aria-hidden>{(persona.name || '?').slice(0, 1)}</span>
                    )
                  )}
                  <div className={`video-chat-bubble ${m.role}`}>
                    <span className="video-chat-bubble-text">{m.text}{m.streaming ? '…' : ''}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="video-chat-footer">
              {streamError && <p className="video-chat-error">{streamError}</p>}
              {micError && <p className="video-chat-error">{micError}</p>}
              <p className="video-chat-hint">
                {!micActive
                  ? 'Use the mic on the bar, or type below.'
                  : micListening
                    ? 'Speak now — your line is sent when you pause.'
                    : 'Mic muted — connection stays open. Unmute to speak, or type below.'}
              </p>
              <button
                type="button"
                className="video-chat-type-toggle"
                onClick={() => setShowVideoTextInput((v) => !v)}
              >
                {showVideoTextInput ? 'Hide keyboard' : 'Type a message'}
              </button>
              {showVideoTextInput && (
                <form onSubmit={sendMessage} className="video-chat-form">
                  <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Message…"
                    disabled={sending || integrationBlocked}
                  />
                  <button type="submit" disabled={sending || !input.trim() || integrationBlocked}>Send</button>
                </form>
              )}
              <div className="video-chat-footer-actions">
                <button type="button" className="video-chat-stop" onClick={stopPlayback} disabled={!canStop}>Stop reply</button>
              </div>
            </div>
          </aside>
        </div>
      )}
      <style>{`
        .conv { position: fixed; inset: 0; display: flex; flex-direction: column; background: #000; color: #e4e4e7; }
        .conv a { color: #a78bfa; }
        .conv-header { position: relative; z-index: 20; flex-shrink: 0; padding: 0.5rem 0.75rem; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; background: rgba(0,0,0,0.85); border-bottom: 1px solid rgba(255,255,255,0.1); }
        .conv-header-light { background: rgba(250,250,250,0.96); border-bottom-color: #e4e4e7; color: #18181b; }
        .conv-header-light .conv-header-title { color: #18181b; }
        .conv-header-light a { color: #7c3aed !important; }
        .conv-header-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .integration-banner { flex-shrink: 0; margin: 0; padding: 0.65rem 1rem; background: rgba(127,29,29,0.35); border-bottom: 1px solid rgba(248,113,113,0.35); font-size: 0.82rem; line-height: 1.45; color: #fecaca; }
        .integration-banner-text { margin: 0 0 0.35rem; }
        .integration-banner-actions { margin: 0; font-size: 0.8rem; }
        .integration-banner-actions a { color: #fde68a; }
        .conv-header a { margin-right: 0; color: #a78bfa; }
        .conv h1 { font-family: var(--font-heading); font-size: 0.95rem; font-weight: 600; margin: 0; color: #fff; }
        .conv-header .edit-link { color: #a78bfa; font-size: 0.85rem; }
        .video-stage-layout {
          position: relative;
          flex: 1;
          display: flex;
          min-height: 0;
          width: 100%;
          background: #09090b;
        }
        .video-stage-main {
          flex: 1;
          min-width: 0;
          min-height: 0;
          position: relative;
          display: flex;
          flex-direction: column;
        }
        .audio-stage-layout {
          position: relative;
          flex: 1;
          display: flex;
          min-height: 0;
          width: 100%;
          background: linear-gradient(165deg, #fafafa 0%, #f4f4f5 40%, #ececf0 100%);
        }
        .audio-stage-main {
          flex: 1;
          min-width: 0;
          min-height: 0;
          position: relative;
          display: flex;
          flex-direction: column;
        }
        .audio-wave-wrap {
          flex: 1;
          min-height: 0;
          position: relative;
          display: flex;
          align-items: stretch;
          justify-content: center;
          overflow: hidden;
        }
        .audio-wave-glow {
          position: absolute;
          left: 50%;
          top: 42%;
          transform: translate(-50%, -50%);
          width: min(90vw, 520px);
          height: min(55vh, 380px);
          border-radius: 50%;
          background: radial-gradient(ellipse at center, rgba(167, 139, 250, 0.35) 0%, rgba(124, 58, 237, 0.12) 45%, transparent 70%);
          filter: blur(36px);
          pointer-events: none;
          z-index: 0;
        }
        .audio-wave-canvas {
          position: relative;
          z-index: 1;
          width: 100%;
          height: 100%;
          min-height: 220px;
          display: block;
        }
        .audio-wave-thinking {
          position: absolute;
          bottom: 5.25rem;
          left: 50%;
          transform: translateX(-50%);
          z-index: 4;
          padding: 0.4rem 0.9rem;
          border-radius: 999px;
          font-size: 0.8rem;
          font-weight: 500;
          background: rgba(24, 24, 27, 0.88);
          color: #fafafa;
          pointer-events: none;
          box-shadow: 0 8px 24px rgba(0,0,0,0.15);
          animation: pulse 1.5s ease-in-out infinite;
        }
        .audio-wave-status {
          position: absolute;
          left: 50%;
          bottom: 5.25rem;
          transform: translateX(-50%);
          z-index: 3;
          font-size: 0.72rem;
          font-weight: 600;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: #71717a;
          pointer-events: none;
        }
        .audio-wave-wrap-thinking .audio-wave-status {
          bottom: 6.85rem;
        }
        .audio-hidden-element {
          position: absolute;
          width: 1px;
          height: 1px;
          margin: -1px;
          padding: 0;
          border: 0;
          clip: rect(0 0 0 0);
          overflow: hidden;
          white-space: nowrap;
          opacity: 0;
          pointer-events: none;
          left: 0;
          bottom: 0;
        }
        .audio-floating-bar {
          position: absolute;
          left: 0;
          right: 0;
          bottom: 0;
          z-index: 25;
          display: flex;
          justify-content: center;
          padding: 1rem 1rem 1.35rem;
          pointer-events: none;
          background: linear-gradient(to top, rgba(244,244,245,0.98) 0%, rgba(250,250,250,0.55) 50%, transparent 100%);
        }
        .audio-floating-bar-inner {
          pointer-events: auto;
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 0.5rem 0.65rem;
          padding: 0.45rem 0.55rem 0.45rem 0.85rem;
          border-radius: 999px;
          background: linear-gradient(135deg, rgba(109, 40, 217, 0.92) 0%, rgba(91, 33, 182, 0.95) 50%, rgba(76, 29, 149, 0.98) 100%);
          box-shadow: 0 12px 40px rgba(124, 58, 237, 0.25), 0 0 0 1px rgba(255,255,255,0.12) inset;
        }
        .video-wrap {
          position: absolute;
          inset: 0;
          z-index: 0;
          width: 100%;
          background: #000;
          overflow: hidden;
          pointer-events: none;
        }
        .video-wrap .video-layer {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          object-fit: contain;
          transition: opacity 0.35s ease-out;
          pointer-events: none;
        }
        .video-wrap .video-layer.poster-fallback { z-index: 2; }
        .video-wrap .video-layer.reply-layer { z-index: 1; transition: opacity 0.3s ease-in-out; }
        .video-wrap .video-layer.reply-layer.reply-hiding { transition: opacity 0.35s ease-out; }
        .video-floating-bar {
          position: absolute;
          left: 0;
          right: 0;
          bottom: 0;
          z-index: 25;
          display: flex;
          justify-content: center;
          padding: 1rem 1rem 1.35rem;
          pointer-events: none;
          background: linear-gradient(to top, rgba(0,0,0,0.82) 0%, rgba(0,0,0,0.35) 45%, transparent 100%);
        }
        .video-floating-bar-inner {
          pointer-events: auto;
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 0.5rem 0.65rem;
          padding: 0.45rem 0.55rem 0.45rem 0.85rem;
          border-radius: 999px;
          background: linear-gradient(135deg, rgba(109, 40, 217, 0.92) 0%, rgba(91, 33, 182, 0.95) 50%, rgba(76, 29, 149, 0.98) 100%);
          box-shadow: 0 12px 40px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.12) inset;
        }
        .vf-persona-wrap { position: relative; }
        .vf-bar-menu-wrap { position: relative; }
        .vf-persona-btn {
          display: flex;
          align-items: center;
          gap: 0.35rem;
          border: none;
          background: rgba(255,255,255,0.14);
          color: #fff;
          font-size: 0.88rem;
          font-weight: 600;
          padding: 0.5rem 0.85rem;
          border-radius: 999px;
          cursor: pointer;
          max-width: 11rem;
        }
        .vf-persona-btn:hover { background: rgba(255,255,255,0.22); }
        .vf-persona-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .vf-chevron { font-size: 0.65rem; opacity: 0.85; }
        .vf-persona-menu {
          position: absolute;
          bottom: calc(100% + 8px);
          left: 0;
          min-width: 11rem;
          padding: 0.35rem 0;
          border-radius: 12px;
          background: #18181b;
          border: 1px solid rgba(255,255,255,0.12);
          box-shadow: 0 16px 48px rgba(0,0,0,0.5);
          z-index: 40;
        }
        .vf-persona-menu a, .vf-persona-menu button {
          display: block;
          width: 100%;
          text-align: left;
          padding: 0.55rem 1rem;
          border: none;
          background: none;
          color: #fafafa;
          font-size: 0.85rem;
          cursor: pointer;
          text-decoration: none;
        }
        .vf-persona-menu a:hover, .vf-persona-menu button:hover { background: rgba(255,255,255,0.08); }
        .vf-persona-menu button.vf-menu-current {
          background: rgba(124, 58, 237, 0.35);
          color: #fafafa;
        }
        .vf-icon-btn {
          width: 44px;
          height: 44px;
          border-radius: 50%;
          border: none;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(255,255,255,0.12);
          color: #fff;
          cursor: pointer;
        }
        .vf-icon-btn:hover:not(:disabled) { background: rgba(255,255,255,0.22); }
        .vf-icon-btn:disabled { opacity: 0.45; cursor: not-allowed; }
        .vf-icon-btn.vf-on { background: rgba(255,255,255,0.28); box-shadow: 0 0 0 2px rgba(255,255,255,0.35); }
        .vf-icon-btn.vf-muted { background: rgba(250,204,21,0.12); box-shadow: 0 0 0 2px rgba(250,204,21,0.4); }
        .vf-svg { width: 22px; height: 22px; display: block; }
        .vf-end-chat {
          display: flex;
          align-items: center;
          gap: 0.4rem;
          border: none;
          border-radius: 999px;
          padding: 0.5rem 1rem 0.5rem 0.65rem;
          background: rgba(0,0,0,0.22);
          color: #fff;
          font-size: 0.82rem;
          font-weight: 600;
          cursor: pointer;
        }
        .vf-end-chat:hover { background: rgba(0,0,0,0.35); }
        .vf-end-icon { width: 20px; height: 20px; opacity: 0.95; }
        .video-chat-drawer {
          flex-shrink: 0;
          width: min(380px, 100vw);
          display: flex;
          flex-direction: column;
          min-height: 0;
          background: #fafafa;
          color: #18181b;
          border-left: 1px solid #e4e4e7;
          box-shadow: -12px 0 40px rgba(0,0,0,0.12);
          transition: width 0.28s ease, opacity 0.22s ease, border-color 0.2s ease;
          overflow: hidden;
        }
        .video-chat-drawer.collapsed {
          width: 0 !important;
          min-width: 0 !important;
          opacity: 0;
          border-left-color: transparent;
          pointer-events: none;
        }
        .video-chat-drawer-head {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.85rem 1rem 0.35rem;
          border-bottom: 1px solid #e4e4e7;
          flex-shrink: 0;
        }
        .video-chat-collapse {
          border: none;
          background: #f4f4f5;
          border-radius: 10px;
          width: 36px;
          height: 36px;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          color: #3f3f46;
        }
        .video-chat-collapse:hover { background: #e4e4e7; }
        .video-chat-title { font-weight: 700; font-size: 1rem; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .video-chat-sub { font-size: 0.72rem; color: #71717a; padding: 0 1rem 0.65rem; flex-shrink: 0; }
        .video-chat-log-light {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          padding: 0.75rem 1rem 1rem;
          display: flex;
          flex-direction: column;
          gap: 0.65rem;
        }
        .video-chat-thinking { font-size: 0.85rem; color: #71717a; font-style: italic; }
        .video-chat-row { display: flex; align-items: flex-end; gap: 0.5rem; max-width: 100%; }
        .video-chat-row.user { justify-content: flex-end; flex-direction: row-reverse; }
        .video-chat-row.assistant { justify-content: flex-start; }
        .video-chat-avatar {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          object-fit: cover;
          flex-shrink: 0;
          border: 2px solid #fff;
          box-shadow: 0 2px 8px rgba(0,0,0,0.12);
        }
        .video-chat-avatar-fallback {
          display: flex;
          align-items: center;
          justify-content: center;
          background: linear-gradient(135deg, #7c3aed, #5b21b6);
          color: #fff;
          font-size: 0.75rem;
          font-weight: 700;
        }
        .video-chat-bubble {
          max-width: calc(100% - 44px);
          padding: 0.65rem 0.85rem;
          border-radius: 18px;
          line-height: 1.45;
          font-size: 0.9rem;
        }
        .video-chat-bubble.user {
          background: linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%);
          color: #fff;
          border-bottom-right-radius: 6px;
        }
        .video-chat-bubble.assistant {
          background: #f4f4f5;
          color: #18181b;
          border-bottom-left-radius: 6px;
          border: 1px solid #e4e4e7;
        }
        .video-chat-bubble-text { word-break: break-word; }
        .video-chat-footer {
          flex-shrink: 0;
          padding: 0.75rem 1rem 1rem;
          border-top: 1px solid #e4e4e7;
          background: #fff;
        }
        .video-chat-error { color: #b91c1c; font-size: 0.8rem; margin: 0 0 0.35rem; }
        .video-chat-hint { font-size: 0.75rem; color: #71717a; margin: 0 0 0.5rem; line-height: 1.4; }
        .video-chat-type-toggle {
          border: none;
          background: none;
          color: #7c3aed;
          font-size: 0.8rem;
          font-weight: 600;
          cursor: pointer;
          padding: 0.25rem 0;
          margin-bottom: 0.5rem;
        }
        .video-chat-type-toggle:hover { text-decoration: underline; }
        .video-chat-form { display: flex; gap: 0.5rem; margin-top: 0.25rem; }
        .video-chat-form input {
          flex: 1;
          min-width: 0;
          padding: 0.55rem 0.75rem;
          border-radius: 12px;
          border: 1px solid #d4d4d8;
          font-size: 0.9rem;
        }
        .video-chat-form input:focus { outline: none; border-color: #7c3aed; box-shadow: 0 0 0 3px rgba(124, 58, 237, 0.15); }
        .video-chat-form button {
          padding: 0.55rem 1rem;
          border-radius: 12px;
          border: none;
          background: #7c3aed;
          color: #fff;
          font-weight: 600;
          cursor: pointer;
        }
        .video-chat-form button:disabled { opacity: 0.45; cursor: not-allowed; }
        .video-chat-footer-actions { margin-top: 0.5rem; }
        .video-chat-stop {
          border: 1px solid #d4d4d8;
          background: #fafafa;
          color: #3f3f46;
          padding: 0.45rem 0.85rem;
          border-radius: 10px;
          font-size: 0.8rem;
          cursor: pointer;
        }
        .video-chat-stop:disabled { opacity: 0.4; cursor: not-allowed; }
        @media (max-width: 720px) {
          .video-chat-drawer {
            position: absolute;
            top: 0;
            right: 0;
            bottom: 0;
            width: min(100vw - 12px, 360px);
            z-index: 30;
            box-shadow: -8px 0 32px rgba(0,0,0,0.22);
            transition: transform 0.28s ease, opacity 0.22s ease, box-shadow 0.2s ease;
          }
          .video-chat-drawer.open {
            transform: translateX(0);
            opacity: 1;
            pointer-events: auto;
          }
          .video-chat-drawer.collapsed {
            transform: translateX(104%);
            opacity: 0;
            pointer-events: none;
            width: min(100vw - 12px, 360px) !important;
            min-width: unset !important;
          }
        }
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
        .audio-layout { display: grid; grid-template-columns: 1fr; padding: 1.25rem; flex: 1; min-height: 0; background: radial-gradient(1200px 400px at 20% 0%, rgba(59,130,246,0.12), transparent 60%), radial-gradient(800px 500px at 80% 10%, rgba(16,185,129,0.12), transparent 55%); }
        .audio-shell { display: grid; grid-template-columns: 1.05fr 0.95fr; gap: 1.5rem; min-height: 0; }
        .audio-left { display: flex; flex-direction: column; gap: 1rem; min-width: 0; }
        .audio-right { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
        .audio-card { border-radius: 18px; padding: 1rem; background: rgba(15,23,42,0.75); border: 1px solid rgba(148,163,184,0.2); box-shadow: 0 24px 60px rgba(0,0,0,0.35); }
        .audio-card-header { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; margin-bottom: 0.75rem; }
        .audio-title { font-size: 1.05rem; font-weight: 600; color: #fff; }
        .audio-mode-pill { font-size: 0.7rem; padding: 0.25rem 0.6rem; border-radius: 999px; text-transform: uppercase; letter-spacing: 0.08em; background: rgba(148,163,184,0.2); color: rgba(255,255,255,0.8); }
        .audio-mode-pill.live { background: rgba(16,185,129,0.25); color: #a7f3d0; }
        .audio-mic-panel { display: flex; flex-direction: column; gap: 0.35rem; align-items: flex-start; padding: 0.75rem 0.85rem; border-radius: 16px; border: 1px solid rgba(148,163,184,0.2); background: rgba(2,6,23,0.6); }
        .audio-mic-hint { font-size: 0.78rem; color: rgba(148,163,184,0.9); }
        .audio-status { font-size: 0.78rem; color: rgba(148,163,184,0.9); }
        .audio-poster { width: 100%; max-height: 62vh; object-fit: contain; background: #0b0f17; border-radius: 14px; border: 1px solid rgba(148,163,184,0.2); }
        .chat-panel { display: flex; flex-direction: column; min-height: 0; height: 100%; background: rgba(8,11,18,0.75); border: 1px solid rgba(148,163,184,0.2); border-radius: 18px; box-shadow: 0 20px 50px rgba(0,0,0,0.35); overflow: hidden; }
        .chat-panel-header { display: flex; align-items: center; justify-content: space-between; padding: 0.85rem 1rem; border-bottom: 1px solid rgba(148,163,184,0.2); }
        .chat-panel-title { font-size: 0.9rem; font-weight: 600; color: rgba(255,255,255,0.9); }
        .chat-log { display: flex; flex-direction: column; gap: 0.6rem; flex: 1; overflow-y: auto; padding: 0.9rem 1rem; }
        .chat-msg { display: flex; flex-direction: column; gap: 0.2rem; padding: 0.6rem 0.8rem; border-radius: 14px; background: rgba(255,255,255,0.06); }
        .chat-msg.user { align-self: flex-end; background: rgba(59,130,246,0.15); }
        .chat-role { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; }
        .chat-text { font-size: 0.9rem; }
        .audio-input-wrap { padding: 0.75rem 1rem 1rem; border-top: 1px solid rgba(148,163,184,0.2); background: rgba(2,6,23,0.55); }
        .audio-input-wrap .input-form { background: rgba(15,23,42,0.6); border: 1px solid rgba(148,163,184,0.2); border-radius: 14px; padding: 0.5rem; gap: 0.5rem; flex-wrap: wrap; }
        .audio-input-wrap .input-form input { background: transparent; border: none; padding: 0.6rem 0.75rem; min-width: 220px; }
        .audio-input-wrap .input-form input:focus { border: none; }
        .audio-input-wrap .input-form button { border-radius: 10px; }
        @media (max-width: 980px) {
          .audio-shell { grid-template-columns: 1fr; }
          .audio-card { order: 1; }
          .chat-panel { order: 2; }
        }
        @media (max-width: 720px) {
          .audio-layout { padding: 0.75rem; }
          .chat-panel { display: none; }
          .audio-left { gap: 0.75rem; }
          .audio-card { padding: 0.85rem; }
          .audio-card-header { flex-direction: column; align-items: flex-start; }
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
