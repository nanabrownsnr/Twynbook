import { useState, useRef, useEffect } from 'react'
import { useNavigate, Link, useLocation } from 'react-router-dom'
import { apiFetch, authHeaders } from '../auth'

const API = '/api'
const STEPS = 3

export default function CreatePersona() {
  const navigate = useNavigate()
  const location = useLocation()
  const [step, setStep] = useState(1)
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [faceFile, setFaceFile] = useState(null)
  const [voiceFile, setVoiceFile] = useState(null)
  const [purchases, setPurchases] = useState([])
  const [purchasesLoading, setPurchasesLoading] = useState(true)
  const [selectedAvatarId, setSelectedAvatarId] = useState('')
  const [selectedRolePackId, setSelectedRolePackId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(() => location.state?.creationError ?? null)

  const listingType = (l) => l.listing_type || 'integration'
  const purchasedAvatars = purchases.filter((l) => listingType(l) === 'avatar')
  const purchasedRolePacks = purchases.filter((l) => listingType(l) === 'role_pack')
  const purchasedTools = purchases.filter((l) => listingType(l) === 'integration')
  const [selectedToolIds, setSelectedToolIds] = useState([])
  const [marketplaceModalOpen, setMarketplaceModalOpen] = useState(false)
  const [marketplaceListings, setMarketplaceListings] = useState([])
  const [marketplaceLoading, setMarketplaceLoading] = useState(false)
  const [marketplaceBuying, setMarketplaceBuying] = useState(null)
  const [docFiles, setDocFiles] = useState([])

  const loadPurchases = () => {
    setPurchasesLoading(true)
    return apiFetch(`${API}/me/purchases`)
      .then((r) => (r.ok ? r.json() : { purchases: [] }))
      .then((d) => setPurchases(d.purchases || []))
      .catch(() => setPurchases([]))
      .finally(() => setPurchasesLoading(false))
  }

  useEffect(() => {
    loadPurchases()
  }, [])

  useEffect(() => {
    if (marketplaceModalOpen && marketplaceListings.length === 0) {
      setMarketplaceLoading(true)
      fetch(`${API}/marketplace`)
        .then((r) => r.json())
        .then((d) => setMarketplaceListings(d.listings || []))
        .catch(() => setMarketplaceListings([]))
        .finally(() => setMarketplaceLoading(false))
    }
  }, [marketplaceModalOpen])

  const marketplaceToolListings = marketplaceListings.filter((l) => listingType(l) === 'integration')
  const isOwnedInModal = (id) => purchases.some((p) => p.id === id)
  const handleMarketplaceBuy = (listing) => {
    setMarketplaceBuying(listing.id)
    apiFetch(`${API}/marketplace/${listing.id}/purchase`, { method: 'POST' })
      .then((r) => {
        if (r.ok) {
          loadPurchases().then(() => setMarketplaceModalOpen(false))
        }
      })
      .finally(() => setMarketplaceBuying(null))
  }

  const toggleTool = (id) => {
    setSelectedToolIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  useEffect(() => {
    if (location.state?.creationError) {
      navigate('.', { replace: true, state: {} })
    }
  }, [location.state?.creationError, navigate])

  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const [cameraActive, setCameraActive] = useState(false)
  const [cameraReady, setCameraReady] = useState(false)
  const [cameraError, setCameraError] = useState(null)
  const mediaRecorderRef = useRef(null)
  const audioStreamRef = useRef(null)
  const [recording, setRecording] = useState(false)
  const [recordingTime, setRecordingTime] = useState(0)
  const recordingTimerRef = useRef(null)
  const [recordError, setRecordError] = useState(null)

  const startCamera = () => {
    setCameraError(null)
    setCameraReady(false)
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } })
      .then((stream) => {
        streamRef.current = stream
        setCameraActive(true)
      })
      .catch((err) => setCameraError(err.message || 'Could not access camera'))
  }

  useEffect(() => {
    if (!cameraActive || !streamRef.current || !videoRef.current) return
    const video = videoRef.current
    video.srcObject = streamRef.current
    const p = video.play()
    if (p && typeof p.catch === 'function') p.catch(() => {})
    const onLoadedData = () => setCameraReady(true)
    const onError = () => setCameraReady(false)
    video.addEventListener('loadeddata', onLoadedData)
    video.addEventListener('error', onError)
    return () => {
      video.removeEventListener('loadeddata', onLoadedData)
      video.removeEventListener('error', onError)
    }
  }, [cameraActive])

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    if (videoRef.current) videoRef.current.srcObject = null
    setCameraActive(false)
    setCameraReady(false)
    setCameraError(null)
  }

  useEffect(() => {
    return () => {
      stopCamera()
      if (audioStreamRef.current) {
        audioStreamRef.current.getTracks().forEach((t) => t.stop())
      }
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current)
    }
  }, [])

  const captureSelfie = () => {
    const video = videoRef.current
    if (!video || !streamRef.current || !video.videoWidth || !video.videoHeight) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    ctx.drawImage(video, 0, 0)
    canvas.toBlob(
      (blob) => {
        if (blob) {
          const file = new File([blob], 'selfie.png', { type: 'image/png' })
          setFaceFile(file)
          stopCamera()
        }
      },
      'image/png',
      0.95
    )
  }

  const clearFace = () => setFaceFile(null)

  const startRecording = () => {
    setRecordError(null)
    setVoiceFile(null)
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        audioStreamRef.current = stream
        const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
        const recorder = new MediaRecorder(stream, { mimeType: mime })
        const chunks = []
        recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
        recorder.onstop = () => {
          stream.getTracks().forEach((t) => t.stop())
          audioStreamRef.current = null
          if (chunks.length) {
            const blob = new Blob(chunks, { type: mime })
            const ext = mime.includes('webm') ? 'webm' : 'ogg'
            setVoiceFile(new File([blob], `recording.${ext}`, { type: blob.type }))
          }
          if (recordingTimerRef.current) {
            clearInterval(recordingTimerRef.current)
            recordingTimerRef.current = null
          }
          setRecordingTime(0)
        }
        recorder.start(100)
        mediaRecorderRef.current = recorder
        setRecording(true)
        setRecordingTime(0)
        recordingTimerRef.current = setInterval(() => setRecordingTime((t) => t + 1), 1000)
      })
      .catch((err) => setRecordError(err.message || 'Could not access microphone'))
  }

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop()
    }
    setRecording(false)
  }

  const clearVoice = () => setVoiceFile(null)

  const goNext = () => {
    setError(null)
    if (step === 1 && !name.trim()) {
      setError('Please enter a name for your twin.')
      return
    }
    setStep((s) => Math.min(s + 1, STEPS))
  }

  const goBack = () => {
    setError(null)
    setStep((s) => Math.max(s - 1, 1))
  }

  const buildSystemPrompt = () => {
    const parts = []
    if (role.trim()) parts.push(`Role: ${role.trim()}.`)
    if (systemPrompt.trim()) parts.push(systemPrompt.trim())
    return parts.join('\n\n')
  }

  const handleCreate = (e) => {
    e.preventDefault()
    setError(null)
    const usePurchasedAvatar = !!selectedAvatarId && purchasedAvatars.some((a) => a.id === selectedAvatarId)
    const missing = []
    if (!name.trim()) missing.push('name')
    if (!usePurchasedAvatar) {
      if (!faceFile) missing.push('face (take a selfie or upload an image)')
      if (!voiceFile) missing.push('voice (record or upload audio)')
    }
    if (missing.length) {
      setError('Please complete step 2: ' + missing.join(', ') + '.')
      return
    }
    setSubmitting(true)
    const form = new FormData()
    form.set('name', name.trim())
    form.set('system_prompt', buildSystemPrompt())
    if (usePurchasedAvatar) {
      form.set('avatar_listing_id', selectedAvatarId)
    } else {
      form.set('face', faceFile)
      form.set('voice', voiceFile)
    }
    if (selectedRolePackId && purchasedRolePacks.some((r) => r.id === selectedRolePackId)) {
      form.set('assigned_role_pack_id', selectedRolePackId)
    }
    if (selectedToolIds.length > 0) {
      form.set('assigned_listing_ids', JSON.stringify(selectedToolIds))
    }
    docFiles.forEach((file) => form.append('documents', file))
    apiFetch(`${API}/personas/create`, { method: 'POST', body: form })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}))
        if (r.status === 202) return { accepted: true, id: data.id }
        if (!r.ok) {
          const msg = data.detail != null ? (typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)) : r.statusText
          throw new Error(msg)
        }
        return data
      })
      .then((result) => {
        if (result.accepted) {
          setSubmitting(false)
          navigate('/creating', { state: { creatingPersonaId: result.id } })
        } else {
          navigate('/persona/' + result.id)
        }
      })
      .catch((e) => {
        setError(e.message)
        setSubmitting(false)
      })
  }

  return (
    <div className="create-page">
      <header className="create-header">
        <Link to="/app" className="create-back">Back</Link>
        <h1 className="create-title">Create digital twin</h1>
        {step === 1 && (
          <p className="create-intro">Give your twin a face, voice, and personality.</p>
        )}
        <div className="create-progress" aria-label={`Step ${step} of ${STEPS}`}>
          <span className="create-progress-text">Step {step} of {STEPS}</span>
          <div className="create-progress-dots">
            {[1, 2, 3].map((i) => (
              <span key={i} className={`create-progress-dot ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`} />
            ))}
          </div>
        </div>
      </header>

      <form onSubmit={step < STEPS ? (e) => { e.preventDefault(); goNext(); } : handleCreate} className="create-form">
        {step === 1 && (
          <div className="create-step create-step-1">
            <div className="create-fieldset">
              <label>
                Name
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your twin's name"
                  required
                />
              </label>
              <label>
                Role <span className="create-optional">(optional)</span>
                {purchasesLoading ? (
                  <p className="create-field-hint">Loading…</p>
                ) : purchasedRolePacks.length > 0 ? (
                  <>
                    <select
                      value={selectedRolePackId || (role.trim() ? '__custom__' : '')}
                      onChange={(e) => {
                        const v = e.target.value
                        if (v === '__custom__' || v === '') {
                          setSelectedRolePackId('')
                          if (v === '') setRole('')
                        } else {
                          setSelectedRolePackId(v)
                          setRole('')
                        }
                      }}
                      className="create-role-select"
                    >
                      <option value="">None</option>
                      {purchasedRolePacks.map((r) => (
                        <option key={r.id} value={r.id}>{r.name}</option>
                      ))}
                      <option value="__custom__">Write my own</option>
                    </select>
                    {selectedRolePackId ? (
                      <p className="create-field-hint">Using purchased role. Choose &quot;Write my own&quot; above to type a custom role instead.</p>
                    ) : (
                      <input
                        type="text"
                        value={role}
                        onChange={(e) => setRole(e.target.value)}
                        placeholder="e.g. Sales lead, Coach, Assistant"
                        className="create-role-input"
                      />
                    )}
                  </>
                ) : (
                  <input
                    type="text"
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    placeholder="e.g. Sales lead, Coach, Assistant"
                    className="create-role-input"
                  />
                )}
              </label>
              <label>
                About <span className="create-optional">(personality)</span>
                <textarea
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  placeholder="e.g. My name is Nana. I'm a friendly character who speaks briefly."
                  rows={4}
                />
              </label>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="create-step create-step-2">
            <div className="create-fieldset create-avatar-choice">
              <legend>Face &amp; voice</legend>
              {purchasesLoading ? (
                <p className="create-field-hint">Loading your purchases…</p>
              ) : purchasedAvatars.length > 0 ? (
                <>
                  <label className="create-avatar-select-label">
                    Use an avatar you purchased
                    <select value={selectedAvatarId} onChange={(e) => { setSelectedAvatarId(e.target.value); if (e.target.value) { setFaceFile(null); setVoiceFile(null) } }} className="create-avatar-select">
                      <option value="">— Or upload your own face and voice below —</option>
                      {purchasedAvatars.map((a) => (
                        <option key={a.id} value={a.id}>{a.name}</option>
                      ))}
                    </select>
                  </label>
                  <p className="create-field-hint">Choosing an avatar uses its face and voice. You can still add name and personality in step 1.</p>
                </>
              ) : (
                <p className="create-field-hint">You have no purchased avatars yet. <Link to="/marketplace">Buy an avatar in the Marketplace</Link> to use one here, or upload your own face and voice below.</p>
              )}
            </div>
            <fieldset className="create-fieldset" style={selectedAvatarId ? { opacity: 0.6 } : undefined}>
              <legend>Face image {selectedAvatarId ? '(optional when using purchased avatar)' : ''}</legend>
              <p className="create-field-hint">We&apos;ll use this to animate your twin.</p>
              {!cameraActive ? (
                <button type="button" className="btn-secondary" onClick={startCamera} disabled={!!faceFile || !!selectedAvatarId}>
                  {faceFile ? 'Photo set (clear below to retake)' : 'Take selfie'}
                </button>
              ) : (
                <div className="camera-box">
                  <video ref={videoRef} autoPlay playsInline muted className="camera-video" />
                  {!cameraReady && <p className="camera-status">Starting camera…</p>}
                  <div className="camera-actions">
                    <button type="button" className="btn-primary" onClick={captureSelfie} disabled={!cameraReady}>Take photo</button>
                    <button type="button" className="btn-secondary" onClick={stopCamera}>Cancel</button>
                  </div>
                </div>
              )}
              {cameraError && <p className="error">{cameraError}</p>}
              {faceFile && (
                <p className="file-set">
                  <span>Photo set: {faceFile.name}</span>
                  <button type="button" className="btn-link" onClick={clearFace}>Clear</button>
                </p>
              )}
              <p className="or">or upload an image</p>
              <input type="file" accept="image/png,image/jpeg,image/jpg,image/webp" onChange={(e) => { const f = e.target.files?.[0]; if (f) { setFaceFile(f); setSelectedAvatarId('') } }} disabled={!!selectedAvatarId} />
            </fieldset>
            <fieldset className="create-fieldset" style={selectedAvatarId ? { opacity: 0.6 } : undefined}>
              <legend>Voice {selectedAvatarId ? '(optional when using purchased avatar)' : ''}</legend>
              <p className="create-field-hint">This will be your twin&apos;s voice.</p>
              {!recording ? (
                <button type="button" className="btn-secondary" onClick={startRecording} disabled={!!selectedAvatarId}>Record voice</button>
              ) : (
                <div className="record-box">
                  <span className="record-dot" /> Recording… {recordingTime}s
                  <button type="button" className="btn-danger" onClick={stopRecording}>Stop recording</button>
                </div>
              )}
              {recordError && <p className="error">{recordError}</p>}
              {voiceFile && !recording && (
                <p className="file-set">
                  <span>Recording set: {voiceFile.name}</span>
                  <button type="button" className="btn-link" onClick={clearVoice}>Clear</button>
                </p>
              )}
              <p className="or">or upload an audio file (WAV preferred)</p>
              <input type="file" accept="audio/*,.wav" onChange={(e) => { const f = e.target.files?.[0]; if (f) { setVoiceFile(f); setSelectedAvatarId('') } }} disabled={!!selectedAvatarId} />
            </fieldset>
          </div>
        )}

        {step === 3 && (
          <div className="create-step create-step-3">
            <h3 className="create-tools-title">Tools for this twyn</h3>
            {purchasesLoading ? (
              <p className="create-field-hint">Loading your purchases…</p>
            ) : purchasedTools.length > 0 ? (
              <>
                <div className="create-tools-list">
                  {purchasedTools.map((listing) => (
                    <label key={listing.id} className="create-tool-row">
                      <input
                        type="checkbox"
                        checked={selectedToolIds.includes(listing.id)}
                        onChange={() => toggleTool(listing.id)}
                      />
                      <div className="create-tool-info">
                        {listing.logo_url && <img src={listing.logo_url} alt="" className="create-tool-logo" />}
                        <span className="create-tool-name">{listing.name}</span>
                      </div>
                    </label>
                  ))}
                </div>
                <button type="button" className="create-no-tools-link btn-marketplace-inline" onClick={() => setMarketplaceModalOpen(true)}>
                  Browse more tools in marketplace →
                </button>
              </>
            ) : null}
            <div className="create-kb-section">
              <h3 className="create-tools-title">Knowledge base <span className="create-optional">(optional)</span></h3>
              <p className="create-kb-hint">Add PDF or TXT documents. Your twyn will use them when answering questions.</p>
              <label className="create-doc-upload">
                <input
                  type="file"
                  accept=".pdf,.txt"
                  multiple
                  onChange={(e) => setDocFiles(Array.from(e.target.files || []))}
                />
                <span className="create-doc-upload-btn">Choose files…</span>
              </label>
              {docFiles.length > 0 && (
                <ul className="create-doc-list">
                  {docFiles.map((f, i) => (
                    <li key={i} className="create-doc-item">
                      {f.name}
                      <button type="button" className="btn-link" onClick={() => setDocFiles((prev) => prev.filter((_, j) => j !== i))}>Remove</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {purchasedTools.length === 0 && (
              <div className="create-no-tools">
                <svg className="create-no-tools-icon" xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/><line x1="12" y1="12" x2="12" y2="16"/><line x1="10" y1="14" x2="14" y2="14"/></svg>
                <p className="create-no-tools-text">No tools purchased yet.</p>
                <p className="create-no-tools-hint">Buy tools in the marketplace to upskill your twyn. You can assign them here or after creation.</p>
                <button type="button" className="create-no-tools-link" onClick={() => setMarketplaceModalOpen(true)}>Browse marketplace →</button>
              </div>
            )}
          </div>
        )}

        {marketplaceModalOpen && (
          <div className="create-marketplace-overlay" onClick={() => setMarketplaceModalOpen(false)}>
            <div className="create-marketplace-modal" onClick={(e) => e.stopPropagation()}>
              <div className="create-marketplace-header">
                <h3>Buy tools</h3>
                <button type="button" className="create-marketplace-close" onClick={() => setMarketplaceModalOpen(false)} aria-label="Close">×</button>
              </div>
              <p className="create-marketplace-hint">Quick buy a tool and continue creating. Your progress is saved.</p>
              {marketplaceLoading ? (
                <p className="create-field-hint">Loading…</p>
              ) : marketplaceToolListings.length === 0 ? (
                <p className="create-field-hint">No tools in the marketplace yet.</p>
              ) : (
                <div className="create-marketplace-grid">
                  {marketplaceToolListings.map((listing) => (
                    <div key={listing.id} className="create-marketplace-card">
                      {listing.logo_url && <img src={listing.logo_url} alt="" className="create-marketplace-card-logo" />}
                      <span className="create-marketplace-card-name">{listing.name}</span>
                      {listing.price > 0 && <span className="create-marketplace-card-price">${listing.price.toFixed(2)}/mo</span>}
                      {isOwnedInModal(listing.id) ? (
                        <span className="create-marketplace-owned">Owned</span>
                      ) : (
                        <button
                          type="button"
                          className="btn-primary create-marketplace-buy"
                          disabled={marketplaceBuying === listing.id}
                          onClick={() => handleMarketplaceBuy(listing)}
                        >
                          {marketplaceBuying === listing.id ? 'Processing…' : listing.price > 0 ? `Buy $${listing.price.toFixed(2)}/mo` : 'Add free'}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {error && <p className="error">{error}</p>}

        <div className="create-actions">
          {step > 1 && (
            <button type="button" className="btn-secondary" onClick={goBack} disabled={submitting}>
              Back
            </button>
          )}
          {step < STEPS ? (
            <button type="submit" className="btn-primary">Next</button>
          ) : (
            <button type="submit" className="btn-primary" disabled={submitting}>
              {submitting ? 'Creating…' : 'Create my twyn'}
            </button>
          )}
        </div>
      </form>

      <style>{`
        .create-page { padding: 2rem; max-width: 520px; margin: 0 auto; background: var(--bg-page); min-height: 100vh; }
        .create-header { margin-bottom: 1.5rem; }
        .create-back { display: inline-block; margin-bottom: 0.5rem; color: var(--primary); font-size: 0.95rem; }
        .create-back:hover { text-decoration: none; }
        .create-title { font-family: var(--font-heading); font-size: 1.5rem; font-weight: 600; margin: 0 0 0.25rem; color: var(--text-primary); }
        .create-intro { font-size: 0.95rem; color: var(--text-secondary); margin: 0 0 1rem; line-height: 1.4; }
        .create-progress { margin-bottom: 1.25rem; }
        .create-progress-text { font-size: 0.85rem; color: var(--text-muted); }
        .create-progress-dots { display: flex; gap: 0.5rem; margin-top: 0.35rem; }
        .create-progress-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--border); transition: background 0.2s; }
        .create-progress-dot.active { background: var(--primary); }
        .create-progress-dot.done { background: var(--text-muted); }
        .create-form label { display: block; margin-bottom: 1rem; color: var(--text-primary); }
        .create-optional { font-weight: 400; color: var(--text-muted); font-size: 0.9rem; }
        .create-form input[type="text"], .create-form textarea { width: 100%; padding: 0.5rem 0.75rem; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-input); color: var(--text-primary); margin-top: 0.25rem; }
        .create-form input:focus, .create-form textarea:focus { outline: none; border-color: var(--border-focus); box-shadow: 0 0 0 2px var(--primary-muted); }
        .create-form input[type="file"] { margin-top: 0.25rem; }
        .create-form .error { color: var(--error); margin-bottom: 0.5rem; }
        .create-fieldset { border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 1.25rem; margin-bottom: 1rem; background: var(--bg-card); }
        .create-fieldset legend { padding: 0 0.25rem; font-weight: 600; color: var(--text-primary); }
        .create-field-hint { font-size: 0.875rem; color: var(--text-muted); margin: 0 0 0.5rem; }
        .create-step { margin-bottom: 1rem; }
        .create-role-select { display: block; width: 100%; padding: 0.5rem 0.75rem; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-input); color: var(--text-primary); font-size: 0.95rem; margin-top: 0.25rem; }
        .create-role-input { display: block; width: 100%; padding: 0.5rem 0.75rem; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-input); color: var(--text-primary); margin-top: 0.25rem; }
        .create-actions { display: flex; gap: 0.75rem; align-items: center; margin-top: 1rem; flex-wrap: wrap; }
        .btn-secondary { padding: 0.5rem 0.75rem; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-card); color: var(--text-primary); cursor: pointer; }
        .btn-secondary:hover:not(:disabled) { background: var(--border); }
        .btn-secondary:disabled { opacity: 0.7; cursor: default; }
        .btn-primary { padding: 0.6rem 1.2rem; border-radius: var(--radius); border: none; background: var(--primary); color: #fff; font-weight: 600; cursor: pointer; }
        .btn-primary:hover:not(:disabled) { background: var(--primary-hover); }
        .btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }
        .btn-danger { padding: 0.5rem 0.75rem; border-radius: var(--radius); border: none; background: var(--error); color: #fff; cursor: pointer; margin-left: 0.5rem; }
        .btn-link { background: none; border: none; color: var(--primary); cursor: pointer; padding: 0 0.25rem; font-size: 0.9rem; }
        .btn-link:hover { text-decoration: underline; }
        .camera-box { margin: 0.5rem 0; }
        .camera-video { width: 100%; max-width: 480px; border-radius: var(--radius-lg); background: var(--text-muted); display: block; border: 1px solid var(--border); }
        .camera-status { font-size: 0.9rem; color: var(--text-muted); margin: 0.25rem 0; }
        .camera-actions { margin-top: 0.5rem; }
        .camera-actions button:disabled { opacity: 0.6; cursor: not-allowed; }
        .record-box { display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem; margin: 0.5rem 0; }
        .record-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--error); animation: create-pulse 1s infinite; }
        @keyframes create-pulse { 50% { opacity: 0.5; } }
        .file-set { font-size: 0.9rem; color: var(--text-secondary); margin: 0.25rem 0; }
        .or { font-size: 0.85rem; color: var(--text-muted); margin: 0.75rem 0 0.25rem; }
        .create-no-tools { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 2rem 1rem; background: var(--bg-card); border: 1px dashed var(--border); border-radius: var(--radius-lg); gap: 0.5rem; }
        .create-no-tools-icon { color: var(--text-muted); margin-bottom: 0.25rem; }
        .create-no-tools-text { font-weight: 600; color: var(--text-primary); margin: 0; font-size: 1rem; }
        .create-no-tools-hint { font-size: 0.9rem; color: var(--text-secondary); margin: 0; max-width: 320px; line-height: 1.4; }
        .create-no-tools-link { display: inline-block; margin-top: 0.5rem; color: var(--primary); font-weight: 600; font-size: 0.95rem; text-decoration: none; background: none; border: none; cursor: pointer; }
        .create-no-tools-link:hover { text-decoration: underline; }
        .create-tools-title { font-size: 1rem; font-weight: 600; margin: 0 0 0.75rem; color: var(--text-primary); }
        .create-tools-list { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1rem; }
        .create-tool-row { display: flex; align-items: center; gap: 0.5rem; cursor: pointer; padding: 0.5rem; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-card); }
        .create-tool-info { display: flex; align-items: center; gap: 0.5rem; }
        .create-tool-logo { width: 24px; height: 24px; object-fit: contain; border-radius: 4px; }
        .create-tool-name { font-weight: 500; color: var(--text-primary); }
        .btn-marketplace-inline { margin-top: 0.5rem; }
        .create-marketplace-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 1rem; }
        .create-marketplace-modal { background: var(--bg-page); border-radius: var(--radius-lg); max-width: 480px; width: 100%; max-height: 85vh; overflow: auto; padding: 1.25rem; box-shadow: 0 8px 24px rgba(0,0,0,0.2); }
        .create-marketplace-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
        .create-marketplace-header h3 { margin: 0; font-size: 1.15rem; }
        .create-marketplace-close { background: none; border: none; font-size: 1.5rem; cursor: pointer; color: var(--text-muted); line-height: 1; padding: 0 0.25rem; }
        .create-marketplace-close:hover { color: var(--text-primary); }
        .create-marketplace-hint { font-size: 0.875rem; color: var(--text-secondary); margin: 0 0 1rem; }
        .create-marketplace-grid { display: flex; flex-direction: column; gap: 0.75rem; }
        .create-marketplace-card { display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-card); flex-wrap: wrap; }
        .create-marketplace-card-logo { width: 32px; height: 32px; object-fit: contain; border-radius: 4px; }
        .create-marketplace-card-name { flex: 1; font-weight: 500; }
        .create-marketplace-card-price { font-size: 0.9rem; color: var(--text-muted); }
        .create-marketplace-owned { font-size: 0.9rem; color: var(--primary); font-weight: 600; }
        .create-marketplace-buy { flex-shrink: 0; }
        .create-kb-section { margin-top: 1.5rem; padding-top: 1.25rem; border-top: 1px solid var(--border); }
        .create-kb-hint { font-size: 0.875rem; color: var(--text-muted); margin: 0 0 0.5rem; }
        .create-doc-upload { display: inline-block; cursor: pointer; }
        .create-doc-upload input { position: absolute; width: 0; height: 0; opacity: 0; }
        .create-doc-upload-btn { display: inline-block; padding: 0.5rem 0.75rem; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-input); color: var(--primary); font-size: 0.9rem; }
        .create-doc-upload-btn:hover { border-color: var(--primary); }
        .create-doc-list { list-style: none; margin: 0.5rem 0 0; padding: 0; }
        .create-doc-item { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.35rem 0; font-size: 0.9rem; color: var(--text-secondary); }
        .create-avatar-choice { margin-bottom: 1rem; }
        .create-avatar-select-label, .create-role-pack-label { display: flex; flex-direction: column; gap: 0.25rem; }
        .create-avatar-select, .create-role-pack-select { padding: 0.5rem 0.75rem; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-input); color: var(--text-primary); font-size: 0.95rem; margin-top: 0.25rem; }
        .create-role-pack-choice { margin-bottom: 1rem; }
      `}</style>
    </div>
  )
}
