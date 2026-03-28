import { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { apiFetch } from '../auth'

const API = '/api'

export default function EditPersona() {
  const { personaId } = useParams()
  const navigate = useNavigate()
  const [persona, setPersona] = useState(null)
  const [name, setName] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [purchases, setPurchases] = useState([])
  const [assignedIds, setAssignedIds] = useState([])
  const [assignedRolePackId, setAssignedRolePackId] = useState('')
  const [documents, setDocuments] = useState([])
  const [documentsLoading, setDocumentsLoading] = useState(false)
  const [uploadingDoc, setUploadingDoc] = useState(false)
  const [docError, setDocError] = useState(null)
  const [shareUrl, setShareUrl] = useState('')
  const [shareLoading, setShareLoading] = useState(false)
  const [shareError, setShareError] = useState(null)

  const listingType = (l) => l.listing_type || 'integration'
  const toolListings = purchases.filter((l) => listingType(l) === 'integration')
  const rolePackListings = purchases.filter((l) => listingType(l) === 'role_pack')

  const loadDocuments = () => {
    if (!personaId) return
    setDocumentsLoading(true)
    apiFetch(`${API}/personas/${personaId}/documents`)
      .then((r) => (r.ok ? r.json() : { documents: [] }))
      .then((d) => setDocuments(d.documents || []))
      .catch(() => setDocuments([]))
      .finally(() => setDocumentsLoading(false))
  }

  useEffect(() => {
    if (!personaId) return
    Promise.all([
      apiFetch(`${API}/personas/${personaId}`).then((r) => r.ok ? r.json() : Promise.reject()),
      apiFetch(`${API}/me/purchases`).then((r) => r.ok ? r.json() : { purchases: [] }),
    ])
      .then(([p, purData]) => {
        setPersona(p)
        setName(p.name || '')
        setSystemPrompt(p.system_prompt || '')
        setAssignedIds(p.assigned_listing_ids || [])
        setAssignedRolePackId(p.assigned_role_pack_id || '')
        setPurchases(purData.purchases || [])
      })
      .catch(() => setPersona(null))
  }, [personaId])

  useEffect(() => {
    if (personaId && persona) loadDocuments()
  }, [personaId, persona])

  const toggleTool = (id) => {
    setAssignedIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])
  }

  const handleUploadDocument = (e) => {
    const file = e.target.files?.[0]
    if (!file || !personaId) return
    setDocError(null)
    setUploadingDoc(true)
    const form = new FormData()
    form.append('file', file)
    apiFetch(`${API}/personas/${personaId}/documents`, { method: 'POST', body: form })
      .then((r) => {
        if (!r.ok) return r.json().then((d) => { throw new Error(d.detail || 'Upload failed') })
        return r.json()
      })
      .then(() => { loadDocuments(); e.target.value = '' })
      .catch((err) => setDocError(err.message || 'Upload failed'))
      .finally(() => setUploadingDoc(false))
  }

  const handleDeleteDocument = (docId) => {
    if (!personaId || !window.confirm('Remove this document from the knowledge base?')) return
    apiFetch(`${API}/personas/${personaId}/documents/${docId}`, { method: 'DELETE' })
      .then((r) => { if (r.ok) loadDocuments() })
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    apiFetch(`${API}/personas/${personaId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name.trim() || undefined,
        system_prompt: systemPrompt.trim() || undefined,
        assigned_listing_ids: assignedIds,
        assigned_role_pack_id: assignedRolePackId.trim() || null,
      }),
    })
      .then((r) => {
        if (!r.ok) return r.text().then((t) => { throw new Error(t) })
        return r.json()
      })
      .then(() => navigate(`/persona/${personaId}`))
      .catch((e) => {
        setError(e.message)
        setSaving(false)
      })
  }

  const handleShare = () => {
    if (!personaId) return
    setShareLoading(true)
    setShareError(null)
    apiFetch(`${API}/personas/${personaId}/share`, { method: 'POST' })
      .then((r) => (r.ok ? r.json() : r.text().then((t) => { throw new Error(t) })))
      .then((d) => {
        setShareUrl(d.url || '')
        if (d.url && navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(d.url).catch(() => {})
        }
      })
      .catch((e) => setShareError(e.message || 'Failed to create share link'))
      .finally(() => setShareLoading(false))
  }

  if (persona === null && personaId) {
    return (
      <div className="edit-page">
        <p>Persona not found.</p>
        <Link to="/app">Back to list</Link>
      </div>
    )
  }
  if (!persona) {
    return (
      <div className="edit-page">
        <p>Loading…</p>
      </div>
    )
  }

  return (
    <div className="edit-page">
      <header>
        <Link to={`/persona/${personaId}`}>Back</Link>
        <div className="edit-header-row">
          <h1>Edit persona</h1>
          <button type="button" className="edit-share-btn" onClick={handleShare} disabled={shareLoading}>
            {shareLoading ? 'Sharing…' : 'Share'}
          </button>
        </div>
      </header>
      <form onSubmit={handleSubmit} className="edit-form">
        <label>
          Name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Persona name"
          />
        </label>
        <label>
          About
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="e.g. My name is Nana. I'm a friendly character who speaks briefly."
            rows={3}
          />
        </label>
        {rolePackListings.length > 0 && (
          <div className="edit-role-pack-section">
            <h3 className="edit-tools-title">Role pack (one per twyn)</h3>
            <select value={assignedRolePackId} onChange={(e) => setAssignedRolePackId(e.target.value)} className="edit-role-pack-select">
              <option value="">None</option>
              {rolePackListings.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>
        )}
        <div className="edit-tools-section">
          <h3 className="edit-tools-title">Tools for this twyn</h3>
          {toolListings.length === 0 ? (
            <div className="edit-tools-empty">
              <p>No tools purchased yet.</p>
              <Link to="/marketplace" className="edit-tools-link">Go to marketplace →</Link>
            </div>
          ) : (
            <div className="edit-tools-list">
              {toolListings.map((listing) => (
                <label key={listing.id} className="edit-tool-row">
                  <input
                    type="checkbox"
                    checked={assignedIds.includes(listing.id)}
                    onChange={() => toggleTool(listing.id)}
                  />
                  <div className="edit-tool-info">
                    {listing.logo_url && <img src={listing.logo_url} alt="" className="edit-tool-logo" />}
                    <span className="edit-tool-name">{listing.name}</span>
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="edit-kb-section">
          <h3 className="edit-tools-title">Knowledge base</h3>
          <p className="edit-kb-hint">Documents you add here are used when the twyn answers questions. PDF and TXT only.</p>
          {documentsLoading ? (
            <p className="edit-kb-loading">Loading…</p>
          ) : (
            <>
              {documents.length > 0 && (
                <ul className="edit-docs-list">
                  {documents.map((doc) => (
                    <li key={doc.id} className="edit-doc-row">
                      <span className="edit-doc-name">{doc.filename || doc.id}</span>
                      <button type="button" className="edit-doc-delete" onClick={() => handleDeleteDocument(doc.id)} aria-label="Remove">Remove</button>
                    </li>
                  ))}
                </ul>
              )}
              <label className="edit-doc-upload">
                <input type="file" accept=".pdf,.txt" onChange={handleUploadDocument} disabled={uploadingDoc} />
                <span className="edit-doc-upload-btn">{uploadingDoc ? 'Uploading…' : 'Upload PDF or TXT'}</span>
              </label>
            </>
          )}
          {docError && <p className="edit-doc-error">{docError}</p>}
        </div>

        {error && <p className="error">{error}</p>}
        {shareUrl && (
          <div className="edit-share-box">
            <label>Share link</label>
            <input type="text" readOnly value={shareUrl} onFocus={(e) => e.target.select()} />
            <small>Anyone with this link can view and chat with your persona.</small>
          </div>
        )}
        {shareError && <p className="error">{shareError}</p>}
        <button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </form>
      <style>{`
        .edit-page { padding: 2rem; max-width: 480px; margin: 0 auto; background: var(--bg-page); min-height: 100vh; }
        .edit-page header { margin-bottom: 1.5rem; }
        .edit-header-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
        .edit-share-btn { padding: 0.45rem 0.9rem; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-card); color: var(--text-primary); font-weight: 600; cursor: pointer; }
        .edit-share-btn:hover:not(:disabled) { border-color: var(--primary); color: var(--primary); }
        .edit-share-btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .edit-page header a { display: inline-block; margin-bottom: 0.5rem; color: var(--primary); }
        .edit-page h1 { font-family: var(--font-heading); font-size: 1.5rem; font-weight: 600; margin: 0; color: var(--text-primary); }
        .edit-form label { display: block; margin-bottom: 1rem; color: var(--text-primary); }
        .edit-form input[type="text"], .edit-form textarea { width: 100%; padding: 0.5rem 0.75rem; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-input); color: var(--text-primary); margin-top: 0.25rem; }
        .edit-form input:focus, .edit-form textarea:focus { outline: none; border-color: var(--border-focus); }
        .edit-form button[type="submit"] { padding: 0.6rem 1.2rem; border-radius: var(--radius); border: none; background: var(--primary); color: #fff; font-weight: 600; cursor: pointer; }
        .edit-form button[type="submit"]:hover:not(:disabled) { background: var(--primary-hover); }
        .edit-form button[type="submit"]:disabled { opacity: 0.6; cursor: not-allowed; }
        .edit-form .error { color: var(--error); margin-bottom: 0.5rem; }
        .edit-share-box { margin: 0.75rem 0 1rem; padding: 0.75rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-card); }
        .edit-share-box label { display: block; font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.35rem; }
        .edit-share-box input { width: 100%; padding: 0.5rem 0.6rem; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-input); color: var(--text-primary); }
        .edit-share-box small { display: block; margin-top: 0.35rem; color: var(--text-muted); }
        .edit-tools-section { margin-bottom: 1.25rem; }
        .edit-tools-title { font-size: 1rem; font-weight: 600; color: var(--text-primary); margin: 0 0 0.6rem; }
        .edit-tools-empty { font-size: 0.9rem; color: var(--text-secondary); display: flex; flex-direction: column; gap: 0.4rem; background: var(--bg-card); border: 1px dashed var(--border); border-radius: var(--radius); padding: 1rem; }
        .edit-tools-empty p { margin: 0; }
        .edit-tools-link { color: var(--primary); font-weight: 600; text-decoration: none; font-size: 0.9rem; }
        .edit-tools-link:hover { text-decoration: underline; }
        .edit-tools-list { display: flex; flex-direction: column; gap: 0.5rem; }
        .edit-tool-row { display: flex; align-items: center; gap: 0.6rem; padding: 0.6rem 0.75rem; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-card); cursor: pointer; }
        .edit-tool-row:hover { border-color: var(--primary); }
        .edit-tool-row input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; accent-color: var(--primary); }
        .edit-tool-info { display: flex; align-items: center; gap: 0.5rem; }
        .edit-tool-logo { width: 24px; height: 24px; object-fit: contain; }
        .edit-tool-name { font-size: 0.9rem; font-weight: 500; color: var(--text-primary); }
        .edit-role-pack-section { margin-bottom: 1.25rem; }
        .edit-role-pack-select { width: 100%; padding: 0.5rem 0.75rem; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-input); color: var(--text-primary); font-size: 0.95rem; margin-top: 0.25rem; }
        .edit-kb-section { margin-bottom: 1.25rem; padding: 1rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-card); }
        .edit-kb-hint { font-size: 0.875rem; color: var(--text-muted); margin: 0 0 0.75rem; }
        .edit-kb-loading { margin: 0; font-size: 0.9rem; color: var(--text-muted); }
        .edit-docs-list { list-style: none; margin: 0 0 0.75rem; padding: 0; }
        .edit-doc-row { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.5rem 0; border-bottom: 1px solid var(--border); }
        .edit-doc-row:last-child { border-bottom: none; }
        .edit-doc-name { font-size: 0.9rem; color: var(--text-primary); }
        .edit-doc-delete { background: none; border: none; color: var(--error); cursor: pointer; font-size: 0.85rem; padding: 0.25rem 0; }
        .edit-doc-delete:hover { text-decoration: underline; }
        .edit-doc-upload { display: inline-block; margin-top: 0.25rem; }
        .edit-doc-upload input { display: none; }
        .edit-doc-upload-btn { display: inline-block; padding: 0.5rem 0.75rem; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-input); color: var(--primary); font-size: 0.9rem; cursor: pointer; }
        .edit-doc-upload-btn:hover { border-color: var(--primary); }
        .edit-doc-upload input { position: absolute; width: 0; height: 0; opacity: 0; }
        .edit-doc-upload input:disabled + .edit-doc-upload-btn { opacity: 0.6; cursor: not-allowed; }
        .edit-doc-error { margin: 0.5rem 0 0; font-size: 0.875rem; color: var(--error); }
      `}</style>
    </div>
  )
}
