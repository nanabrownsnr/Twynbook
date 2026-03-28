import { useEffect, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getToken } from '../auth'

const API = '/api'
const CODECS = 'video/mp4; codecs="avc1.42401E,mp4a.40.2"'
const AUDIO_CODECS = 'audio/mp4; codecs="mp4a.40.2"'
const AUDIO_SAMPLE_RATE = 16000
const AUDIO_START_PAD_SEC = 0.05
const USE_MSE = !(
  typeof import.meta !== 'undefined' &&
  import.meta.env &&
  import.meta.env.VITE_DITTO_STREAMING === '0'
)

function shareChatWsUrl(shareId) {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.host
  return `${proto}//${host}/api/share/${shareId}/chat/stream`
}

export default function PublicPersona() {
  const { shareId } = useParams()
  const [persona, setPersona] = useState(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [mode, setMode] = useState('audio')
  const [chatLog, setChatLog] = useState([])
  const [streamError, setStreamError] = useState(null)
  const [replyState, setReplyState] = useState({ current: null, queue: [], streamDone: false })
  const [audioState, setAudioState] = useState({ current: null, queue: [], streamDone: false })
  const [audioSpeaking, setAudioSpeaking] = useState(false)
  const [showReply, setShowReply] = useState(false)
  const [idleVideoError, setIdleVideoError] = useState(false)
  const [idlePlaying, setIdlePlaying] = useState(false)
  const idleVideoRef = useRef(null)
  const replyVideoRef = useRef(null)
  const audioRef = useRef(null)
  const chatWsRef = useRef(null)
  const mseRef = useRef({ byIndex: {}, revoke: () => {} })
  const audioMseRef = useRef({ sb: null, queue: [], appending: [false], pending: [], revoke: () => {} })
  const audioCtxRef = useRef(null)
  const audioPlayheadRef = useRef(0)
  const audioNodesRef = useRef([])
  const audioPlaybackTimerRef = useRef(null)
  const audioPlaybackLoggedRef = useRef(false)
  const gotFirstClipRef = useRef(false)
  const pendingNewClipRef = useRef(false)
  const clipStartCountRef = useRef(0)
  const streamDoneRef = useRef(false)
  const clearReplyTimeoutRef = useRef(null)
  const longWaitTimeoutRef = useRef(null)
  const abortRef = useRef(false)
  const streamingTextRef = useRef('')
  const hasStreamedTextRef = useRef(false)
  const isLoggedIn = !!getToken()
  const isStreaming = sending || !(mode === 'audio' ? audioState.streamDone : replyState.streamDone)
  const isGenerating = sending && !gotFirstClipRef.current
  const perfRef = useRef({ start: 0, videoStart: 0, audioStart: 0, audioFirstChunk: 0 })
  const canStop = sending || (mode === 'audio' ? !!audioState.current : !!replyState.current)
  const MIN_VIDEO_CLIPS_BEFORE_PLAY = 4
  const chatKey = shareId ? `twynbook:chat:share:${shareId}` : null

  const resetTimers = () => {
    if (clearReplyTimeoutRef.current) {
      clearTimeout(clearReplyTimeoutRef.current)
      clearReplyTimeoutRef.current = null
    }
    if (longWaitTimeoutRef.current) {
      clearTimeout(longWaitTimeoutRef.current)
      longWaitTimeoutRef.current = null
    }
  }

  const idleUrl = shareId ? `${API}/share/${shareId}/idle-video` : null
  const previewUrl = persona?.preview_url || (shareId ? `${API}/share/${shareId}/preview` : null)

  useEffect(() => {
    if (!shareId) return
    fetch(`${API}/share/${shareId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setPersona)
      .catch(() => setPersona(null))
  }, [shareId])

  useEffect(() => {
    if (!chatKey) return
    try {
      const raw = window.localStorage.getItem(chatKey)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) setChatLog(parsed)
      }
    } catch (_) {}
  }, [chatKey])

  useEffect(() => {
    if (!chatKey) return
    try {
      window.localStorage.setItem(chatKey, JSON.stringify(chatLog))
    } catch (_) {}
  }, [chatKey, chatLog])

  useEffect(() => {
    const v = replyVideoRef.current
    if (!v || !replyState.current) return
    v.muted = false
    v.src = replyState.current
    try { v.load() } catch (_) {}
    v.play().catch(() => {})
  }, [replyState.current])

  useEffect(() => {
    const a = audioRef.current
    if (!a || !audioState.current) return
    a.src = audioState.current
    a.play().catch(() => {})
  }, [audioState.current])

  function transitionToIdle() {
    setShowReply(false)
    if (clearReplyTimeoutRef.current) clearTimeout(clearReplyTimeoutRef.current)
    clearReplyTimeoutRef.current = setTimeout(() => {
      clearReplyTimeoutRef.current = null
      setReplyState({ current: null, queue: [], streamDone: false })
      const revoke = mseRef.current.revoke
      if (revoke) setTimeout(revoke, 100)
    }, 400)
  }

  function resumeReplyPlayback() {
    const v = replyVideoRef.current
    setShowReply(true)
    if (!v) return
    if (v.paused || v.readyState < 2) {
      if (clipStartCountRef.current < MIN_VIDEO_CLIPS_BEFORE_PLAY && !streamDoneRef.current) {
        return
      }
      // Frontend buffer disabled; rely on clip gating only.
      v.play().catch(() => {})
    }
  }

  const handleReplyEnded = () => {
    setReplyState((prev) => {
      if (prev.queue.length > 0) {
        return { ...prev, current: prev.queue[0], queue: prev.queue.slice(1) }
      }
      if (!prev.streamDone) {
        return prev
      }
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

  function handleStreamEvent(event, data) {
    if (event === 'video_start') {
      gotFirstClipRef.current = true
      clipStartCountRef.current += 1
      if (longWaitTimeoutRef.current) { clearTimeout(longWaitTimeoutRef.current); longWaitTimeoutRef.current = null }
      pendingNewClipRef.current = true
      if (!perfRef.current.videoStart && perfRef.current.start) {
        perfRef.current.videoStart = performance.now()
        const dt = (perfRef.current.videoStart - perfRef.current.start) / 1000
        console.info(`[ttfr] video_start at ${dt.toFixed(2)}s`)
      }
      if (replyVideoRef.current) {
        try { replyVideoRef.current.muted = false } catch (_) {}
      }
    } else if (event === 'audio_start') {
      gotFirstClipRef.current = true
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
      if (USE_MSE) return
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
      setTimeout(() => transitionToIdle(), 1500)
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
      } catch (_) {}
      pendingNewClipRef.current = false
    }
    if (appending[0] || queue.length > 0) {
      queue.push(chunk)
    } else {
      appending[0] = true
      try {
        sb.appendBuffer(chunk)
        resumeReplyPlayback()
      } catch (_) {
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
      try { chatWsRef.current.__intentionalClose = true } catch (_) {}
      try { chatWsRef.current.close() } catch (_) {}
    }
    const ws = new WebSocket(shareChatWsUrl(shareId))
    ws.binaryType = 'arraybuffer'
    chatWsRef.current = ws
    ws.onopen = () => ws.send(JSON.stringify({ message: text, mode: 'video' }))
    ws.onmessage = (ev) => {
      if (abortRef.current) return
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data)
          handleStreamEvent(msg.event, msg.data || {})
        } catch (_) {}
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
      if (!replyState.streamDone && !gotFirstClipRef.current) {
        setStreamError('Connection closed before streaming started.')
        setSending(false)
        transitionToIdle()
      }
    }
  }

  function runChunkedFlow(text) {
    if (chatWsRef.current) {
      try { chatWsRef.current.__intentionalClose = true } catch (_) {}
      try { chatWsRef.current.close() } catch (_) {}
    }
    const ws = new WebSocket(shareChatWsUrl(shareId))
    chatWsRef.current = ws
    ws.onopen = () => ws.send(JSON.stringify({ message: text, mode: 'video' }))
    ws.onmessage = (ev) => {
      if (abortRef.current) return
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data)
          handleStreamEvent(msg.event, msg.data || {})
        } catch (_) {}
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
      if (!replyState.streamDone && !gotFirstClipRef.current) {
        setStreamError('Connection closed before streaming started.')
        setSending(false)
        transitionToIdle()
      }
    }
  }

  function runAudioFlow(text) {
    if (chatWsRef.current) {
      try { chatWsRef.current.__intentionalClose = true } catch (_) {}
      try { chatWsRef.current.close() } catch (_) {}
    }
    const ws = new WebSocket(shareChatWsUrl(shareId))
    ws.binaryType = 'arraybuffer'
    chatWsRef.current = ws
    ws.onopen = () => ws.send(JSON.stringify({ message: text, mode: 'audio' }))
    ws.onmessage = (ev) => {
      if (abortRef.current) return
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data)
          handleStreamEvent(msg.event, msg.data || {})
        } catch (_) {}
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
      if (!replyState.streamDone && !gotFirstClipRef.current) {
        setStreamError('Connection closed before streaming started.')
        setSending(false)
        transitionToIdle()
      }
    }
  }

  const sendMessage = (e) => {
    if (e) e.preventDefault()
    const text = input.trim()
    if (!text || sending || !shareId) return
    setInput('')
    setSending(true)
    setStreamError(null)
    abortRef.current = false
    gotFirstClipRef.current = false
    clipStartCountRef.current = 0
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
    if (mode === 'audio') {
      setAudioState({ current: null, queue: [], streamDone: false })
      setReplyState({ current: null, queue: [], streamDone: false })
      if (audioCtxRef.current) {
        try { audioCtxRef.current.close() } catch (_) {}
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
    setShowReply(false)
    idleVideoRef.current?.play().catch(() => {})

    if (mode === 'video' && USE_MSE) {
      const ms = new MediaSource()
      const blobUrl = URL.createObjectURL(ms)
      const mseState = {
        sb: null,
        queue: [],
        appending: [false],
        pending: [],
        revoke: () => { try { URL.revokeObjectURL(blobUrl) } catch (_) {} },
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
                } catch (_) {}
                pendingNewClipRef.current = false
              }
              sb.appendBuffer(mseState.queue.shift())
            } else {
              resumeReplyPlayback()
            }
          }
          mseState.sb = sb
          while (mseState.pending.length > 0) {
            const chunk = mseState.pending.shift()
            if (mseState.appending[0]) mseState.queue.push(chunk)
            else {
              mseState.appending[0] = true
              sb.appendBuffer(chunk)
            }
          }
        } catch (_) {}
      }

      setReplyState((prev) => ({ ...prev, current: blobUrl, queue: [], streamDone: false }))

      if (longWaitTimeoutRef.current) clearTimeout(longWaitTimeoutRef.current)
      longWaitTimeoutRef.current = setTimeout(() => {
        if (gotFirstClipRef.current) return
        setStreamError('Response is taking too long. Please try again.')
        setSending(false)
        transitionToIdle()
      }, 90000)

      runMSEFlow(text)
    } else {
      setReplyState({ current: null, queue: [], streamDone: false })
      if (longWaitTimeoutRef.current) clearTimeout(longWaitTimeoutRef.current)
      longWaitTimeoutRef.current = setTimeout(() => {
        if (gotFirstClipRef.current) return
        setStreamError('Response is taking too long. Please try again.')
        setSending(false)
        transitionToIdle()
      }, 90000)
      if (mode === 'audio') {
        runAudioFlow(text)
      } else {
        runChunkedFlow(text)
      }
    }
  }

  const stopPlayback = () => {
    abortRef.current = true
    try { if (chatWsRef.current) chatWsRef.current.__intentionalClose = true } catch (_) {}
    try { chatWsRef.current?.close() } catch (_) {}
    resetTimers()
    gotFirstClipRef.current = false
    pendingNewClipRef.current = false
    clipStartCountRef.current = 0
    streamDoneRef.current = false
    hasStreamedTextRef.current = false
    streamingTextRef.current = ''
    setSending(false)
    setStreamError(null)
    setShowReply(false)
    setAudioSpeaking(false)
    setReplyState({ current: null, queue: [], streamDone: true })
    setAudioState({ current: null, queue: [], streamDone: true })
    try { replyVideoRef.current?.pause() } catch (_) {}
    try {
      const a = audioRef.current
      if (a) {
        a.pause()
        a.removeAttribute('src')
        a.load()
      }
    } catch (_) {}
    if (audioPlaybackTimerRef.current) {
      clearTimeout(audioPlaybackTimerRef.current)
      audioPlaybackTimerRef.current = null
    }
    if (audioCtxRef.current) {
      try {
        audioNodesRef.current.forEach((n) => { try { n.stop() } catch (_) {} })
      } catch (_) {}
      try { audioCtxRef.current.close() } catch (_) {}
      audioCtxRef.current = null
    }
    try { mseRef.current.revoke?.() } catch (_) {}
    try { audioMseRef.current.revoke?.() } catch (_) {}
    mseRef.current = { byIndex: {}, revoke: () => {} }
    audioMseRef.current = { sb: null, queue: [], appending: [false], pending: [], revoke: () => {} }
    transitionToIdle()
  }

  const clearChat = () => {
    setChatLog([])
    if (chatKey) {
      try { window.localStorage.removeItem(chatKey) } catch (_) {}
    }
  }

  const handleModeChange = (nextMode) => {
    if (nextMode === mode) return
    stopPlayback()
    setMode(nextMode)
  }

  if (persona === null && shareId) {
    return (
      <div className="public-page">
        <p>Shared persona not found.</p>
        <Link to="/">Back</Link>
      </div>
    )
  }

  return (
    <div className="public-page">
      <header className="public-header">
        <Link to="/" className="public-back">← Back</Link>
        <div className="public-title">
          <div className="public-badge">Shared persona</div>
          <h1>{persona?.name || 'Shared persona'}</h1>
          <p className="public-subtitle">
            Shared by {persona?.creator_name || 'TwynBook user'}
          </p>
        </div>
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
        {!isLoggedIn && (
          <Link to="/signup" className="public-cta">Create my own persona</Link>
        )}
      </header>

      {mode === 'video' ? (
      <div className="public-video-wrap" aria-hidden="true">
        {isGenerating && (
          <div className="public-status generating">Thinking...</div>
        )}
        {isStreaming && !isGenerating && replyState.queue.length > 0 && (
          <div className="public-status next">Next clip ready</div>
        )}
        {previewUrl && !showReply && (
          <img
            src={previewUrl}
            alt=""
            className="public-video-layer poster-fallback"
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
          className="public-video-layer"
          style={{ opacity: 1 }}
          onError={() => setIdleVideoError(true)}
          onPlaying={() => {
            setIdlePlaying(true)
          }}
          onPause={() => {
            setIdlePlaying(false)
            idleVideoRef.current?.play().catch(() => {})
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
          className={`public-video-layer reply-layer${!showReply ? ' reply-hiding' : ''}`}
          style={{
            opacity: showReply ? 1 : 0,
            pointerEvents: 'none',
            transition: isGenerating ? 'none' : undefined,
          }}
          onPlaying={() => {
            if (longWaitTimeoutRef.current) {
              clearTimeout(longWaitTimeoutRef.current)
              longWaitTimeoutRef.current = null
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
              if (longWaitTimeoutRef.current) {
                clearTimeout(longWaitTimeoutRef.current)
                longWaitTimeoutRef.current = null
              }
              setShowReply(true)
            }
          }}
          onCanPlayThrough={() => {
            if (longWaitTimeoutRef.current) {
              clearTimeout(longWaitTimeoutRef.current)
              longWaitTimeoutRef.current = null
            }
            setShowReply(true)
          }}
          onTimeUpdate={() => {
            if (!showReply && replyVideoRef.current && !replyVideoRef.current.paused) {
              setShowReply(true)
            }
          }}
          onEnded={handleReplyEnded}
          onWaiting={() => {
            if (longWaitTimeoutRef.current) clearTimeout(longWaitTimeoutRef.current)
            longWaitTimeoutRef.current = setTimeout(() => {
              setSending(false)
              transitionToIdle()
            }, 10000)
          }}
          onStalled={() => {
            resumeReplyPlayback()
          }}
        />
      </div>
      ) : (
        <div className="public-audio-layout">
          <div className="public-audio-left">
            {previewUrl && (
              <img
                src={previewUrl}
                alt=""
                className="public-audio-poster"
              />
            )}
            <audio
              ref={audioRef}
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
          <div className="public-audio-right">
            {mode === 'audio' && (
              <div className="public-audio-status">
                {audioSpeaking ? 'Speaking…' : isStreaming ? 'Listening…' : 'Idle'}
              </div>
            )}
            {isGenerating && <div className="public-audio-status">Thinking...</div>}
            <div className="public-chat-log">
              {chatLog.map((m, i) => (
                <div key={`${m.role}-${i}`} className={`public-chat-msg ${m.role}`}>
                  <span className="public-chat-role">{m.role === 'user' ? 'You' : persona?.name || 'Persona'}</span>
                  <span className="public-chat-text">{m.text}</span>
                </div>
              ))}
            </div>
            <div className="public-audio-input-wrap">
              {streamError && <p className="public-error">{streamError}</p>}
              <form className="public-input" onSubmit={sendMessage}>
                <input
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
      )}

      {mode === 'video' && (
        <div className="public-bottom">
          {streamError && <p className="public-error">{streamError}</p>}
          <form className="public-input" onSubmit={sendMessage}>
            <input
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
      )}

      <style>{`
        .public-page { position: fixed; inset: 0; display: flex; flex-direction: column; background: #000; color: #e4e4e7; }
        .public-page a { color: #a78bfa; }
        .public-header { position: relative; z-index: 20; flex-shrink: 0; padding: 0.5rem 0.75rem; display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; background: rgba(0,0,0,0.85); border-bottom: 1px solid rgba(255,255,255,0.1); }
        .public-back { color: #a78bfa; }
        .public-title { display: flex; flex-direction: column; gap: 0.15rem; flex: 1; min-width: 0; }
        .public-badge { align-self: flex-start; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.02em; text-transform: uppercase; color: #111827; background: #fcd34d; padding: 0.15rem 0.45rem; border-radius: 999px; }
        .public-title h1 { margin: 0; font-size: 0.95rem; font-weight: 600; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .public-subtitle { margin: 0; font-size: 0.8rem; color: rgba(255,255,255,0.7); }
        .mode-toggle { display: flex; align-items: center; gap: 0.45rem; }
        .mode-label { font-size: 0.75rem; letter-spacing: 0.04em; text-transform: uppercase; color: rgba(255,255,255,0.6); }
        .mode-label.active { color: #fff; }
        .toggle-switch { position: relative; width: 46px; height: 24px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.2); background: rgba(255,255,255,0.08); cursor: pointer; padding: 0; }
        .toggle-switch.audio { background: rgba(59,130,246,0.25); border-color: rgba(59,130,246,0.6); }
        .toggle-switch.video { background: rgba(16,185,129,0.25); border-color: rgba(16,185,129,0.6); }
        .toggle-switch:disabled { opacity: 0.5; cursor: not-allowed; }
        .toggle-thumb { position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 999px; background: #fff; transition: transform 0.2s ease; }
        .toggle-switch.video .toggle-thumb { transform: translateX(22px); }
        .stop-btn { border: 1px solid rgba(255,255,255,0.2); background: rgba(239,68,68,0.15); color: #fff; padding: 0.6rem 1rem; border-radius: var(--radius); cursor: pointer; }
        .stop-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .clear-btn { border: 1px solid rgba(255,255,255,0.2); background: rgba(59,130,246,0.15); color: #fff; padding: 0.25rem 0.6rem; border-radius: 999px; cursor: pointer; }
        .clear-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .public-cta { margin-left: auto; background: var(--primary); color: #fff; padding: 0.5rem 0.9rem; border-radius: var(--radius); text-decoration: none; font-weight: 600; }
        .public-cta:hover { background: var(--primary-hover); }
        .public-video-wrap { position: relative; z-index: 0; flex: 1; min-height: 0; width: 100%; background: #000; overflow: hidden; pointer-events: none; }
        .public-video-layer { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; transition: opacity 0.35s ease-out; pointer-events: none; }
        .public-video-layer.poster-fallback { z-index: 2; }
        .public-video-layer.reply-layer { z-index: 1; transition: opacity 0.3s ease-in-out; }
        .public-video-layer.reply-layer.reply-hiding { transition: opacity 0.35s ease-out; }
        .public-audio-layout { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; padding: 1rem; flex: 1; min-height: 0; }
        .public-audio-left { display: flex; flex-direction: column; gap: 0.75rem; min-width: 0; }
        .public-audio-right { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
        .public-audio-status { font-size: 0.85rem; color: rgba(255,255,255,0.8); margin-bottom: 0.5rem; }
        .public-audio-poster { width: 100%; max-height: 60vh; object-fit: contain; background: #000; border-radius: 12px; }
        .public-chat-log { display: flex; flex-direction: column; gap: 0.5rem; flex: 1; overflow-y: auto; }
        .public-chat-msg { display: flex; flex-direction: column; gap: 0.15rem; padding: 0.5rem 0.7rem; border-radius: 12px; background: rgba(255,255,255,0.06); }
        .public-chat-msg.user { align-self: flex-end; background: rgba(59,130,246,0.15); }
        .public-chat-role { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; }
        .public-chat-text { font-size: 0.9rem; }
        .public-audio-input-wrap { padding-top: 0.5rem; border-top: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.35); }
        .public-bottom { position: relative; z-index: 20; flex-shrink: 0; background: rgba(0,0,0,0.9); border-top: 1px solid rgba(255,255,255,0.1); }
        .public-input { display: flex; gap: 0.5rem; padding: 0.75rem 1rem; width: 100%; }
        .public-input input { flex: 1; padding: 0.6rem 0.75rem; border-radius: var(--radius); border: 1px solid rgba(255,255,255,0.2); background: rgba(255,255,255,0.08); color: #fff; }
        .public-input input::placeholder { color: rgba(255,255,255,0.5); }
        .public-input input:focus { outline: none; border-color: var(--primary); }
        .public-input button { padding: 0.6rem 1rem; border-radius: var(--radius); border: none; background: var(--primary); color: #fff; font-weight: 500; cursor: pointer; }
        .public-input button:hover:not(:disabled) { background: var(--primary-hover); }
        .public-input button:disabled { opacity: 0.5; cursor: not-allowed; }
        .public-error { color: #f87171; font-size: 0.85rem; padding: 0 1rem; margin: 0 0 0.25rem; }
        .public-status { position: absolute; bottom: 0.75rem; left: 50%; transform: translateX(-50%); z-index: 2; padding: 0.35rem 0.75rem; border-radius: 999px; font-size: 0.8rem; background: rgba(0,0,0,0.75); color: rgba(255,255,255,0.9); pointer-events: none; }
        .public-status.generating { animation: pulse 1.5s ease-in-out infinite; }
        .public-status.next { opacity: 0.85; }
        @keyframes pulse { 50% { opacity: 0.7; } }
      `}</style>
    </div>
  )
}
