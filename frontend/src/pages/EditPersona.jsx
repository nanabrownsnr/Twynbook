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
  /** @type {Record<string, Record<string, string>>} listing_id -> { param_key: value } (secrets; only send non-empty fields on save) */
  const [toolCredentials, setToolCredentials] = useState({})
  const [marketplaceOpen, setMarketplaceOpen] = useState(false)
  const [marketplaceTab, setMarketplaceTab] = useState('tools')
  const [marketplaceListings, setMarketplaceListings] = useState([])
  const [marketplaceLoading, setMarketplaceLoading] = useState(false)
  const [panelBuying, setPanelBuying] = useState(null)
  const [panelSelectedPackIds, setPanelSelectedPackIds] = useState([])
  const [packAttachLoading, setPackAttachLoading] = useState(false)
  const [packAttachError, setPackAttachError] = useState(null)

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

  const loadPurchases = () =>
    apiFetch(`${API}/me/purchases`)
      .then((r) => (r.ok ? r.json() : { purchases: [] }))
      .then((d) => setPurchases(d.purchases || []))

  useEffect(() => {
    if (!personaId) return
    Promise.all([
      apiFetch(`${API}/personas/${personaId}`).then((r) => r.ok ? r.json() : Promise.reject()),
      loadPurchases(),
    ])
      .then(([p]) => {
        setPersona(p)
        setName(p.name || '')
        setSystemPrompt(p.system_prompt || '')
        setAssignedIds(p.assigned_listing_ids || [])
        setAssignedRolePackId(p.assigned_role_pack_id || '')
        setToolCredentials({})
      })
      .catch(() => setPersona(null))
  }, [personaId])

  useEffect(() => {
    if (!marketplaceOpen) return
    setMarketplaceLoading(true)
    fetch(`${API}/marketplace`)
      .then((r) => r.json())
      .then((d) => setMarketplaceListings(d.listings || []))
      .catch(() => setMarketplaceListings([]))
      .finally(() => setMarketplaceLoading(false))
  }, [marketplaceOpen])

  useEffect(() => {
    if (personaId && persona) loadDocuments()
  }, [personaId, persona])

  const toggleTool = (id) => {
    setAssignedIds((prev) => {
      if (prev.includes(id)) {
        setToolCredentials((c) => {
          const next = { ...c }
          delete next[id]
          return next
        })
        return prev.filter((x) => x !== id)
      }
      return [...prev, id]
    })
  }

  const schemaProps = (listing) => {
    const s = listing.tool_params_schema
    if (!s || typeof s !== 'object') return []
    const props = s.properties
    if (!props || typeof props !== 'object') return []
    return Object.keys(props)
  }

  const setToolCredField = (listingId, key, value) => {
    setToolCredentials((c) => ({
      ...c,
      [listingId]: { ...(c[listingId] || {}), [key]: value },
    }))
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

  const openMarketplace = (tab) => {
    setMarketplaceTab(tab)
    setMarketplaceOpen(true)
    setPackAttachError(null)
  }

  const isOwnedId = (id) => purchases.some((p) => p.id === id)

  const handlePanelBuy = (listing) => {
    setPanelBuying(listing.id)
    apiFetch(`${API}/marketplace/${listing.id}/purchase`, { method: 'POST' })
      .then((r) => {
        if (r.ok) loadPurchases()
      })
      .finally(() => setPanelBuying(null))
  }

  const togglePanelPackSelect = (id) => {
    setPanelSelectedPackIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const handleAddSelectedPacks = () => {
    if (!personaId || !panelSelectedPackIds.length) return
    setPackAttachLoading(true)
    setPackAttachError(null)
    apiFetch(`${API}/personas/${personaId}/knowledge-packs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listing_ids: panelSelectedPackIds }),
    })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}))
        if (!r.ok) {
          const det = d.detail
          const msg = typeof det === 'string'
            ? det
            : Array.isArray(det)
              ? det.map((e) => (e && (e.msg || e.message)) || String(e)).join('; ')
              : 'Failed to add packs'
          throw new Error(msg)
        }
        return d
      })
      .then(() => {
        setPanelSelectedPackIds([])
        loadDocuments()
      })
      .catch((e) => setPackAttachError(e.message || 'Failed'))
      .finally(() => setPackAttachLoading(false))
  }

  const integrationMarketListings = marketplaceListings.filter((l) => listingType(l) === 'integration')
  const knowledgeMarketListings = marketplaceListings.filter((l) => listingType(l) === 'knowledge_pack')

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
        tool_credentials: (() => {
          const out = {}
          for (const lid of assignedIds) {
            const row = toolCredentials[lid]
            if (row && typeof row === 'object') {
              const filtered = Object.fromEntries(
                Object.entries(row).filter(([, v]) => v != null && String(v).trim() !== '')
              )
              if (Object.keys(filtered).length > 0) out[lid] = filtered
            }
          }
          return out
        })(),
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
    <div className={`edit-shell ${marketplaceOpen ? 'edit-shell--panel' : ''}`}>
      <div className="edit-main-col">
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
          <div className="edit-section-head">
            <h3 className="edit-tools-title">Tools for this twyn</h3>
            <button type="button" className="edit-marketplace-open-btn" onClick={() => openMarketplace('tools')}>
              Add from marketplace
            </button>
          </div>
          {toolListings.length === 0 ? (
            <div className="edit-tools-empty">
              <p>No tools purchased yet.</p>
              <p className="edit-tools-empty-sub">Open the marketplace panel on the right to buy tools, or visit the full marketplace.</p>
              <button type="button" className="edit-tools-link-btn" onClick={() => openMarketplace('tools')}>Open marketplace panel →</button>
              <Link to="/marketplace" className="edit-tools-link">Full marketplace →</Link>
            </div>
          ) : (
            <>
              <div className="edit-tools-list">
                {toolListings.map((listing) => {
                  const isOn = assignedIds.includes(listing.id)
                  const keys = schemaProps(listing)
                  const configured = persona?.tool_credentials_configured && persona.tool_credentials_configured[listing.id]
                  return (
                    <div key={listing.id} className="edit-tool-block">
                      <label className="edit-tool-row">
                        <input
                          type="checkbox"
                          checked={isOn}
                          onChange={() => toggleTool(listing.id)}
                        />
                        <div className="edit-tool-info">
                          {listing.logo_url && <img src={listing.logo_url} alt="" className="edit-tool-logo" />}
                          <span className="edit-tool-name">{listing.name}</span>
                          {configured && <span className="edit-tool-cred-badge" title="Credentials saved">Saved</span>}
                        </div>
                      </label>
                      {isOn && keys.length > 0 && (
                        <div className="edit-tool-creds">
                          {keys.map((key) => {
                            const field = (listing.tool_params_schema.properties || {})[key] || {}
                            const isSecret = field.secret === true
                            const label = field.label || field.title || key
                            return (
                              <label key={key} className="edit-tool-cred-field">
                                {label}
                                <input
                                  type={isSecret ? 'password' : 'text'}
                                  autoComplete="off"
                                  value={(toolCredentials[listing.id] || {})[key] || ''}
                                  onChange={(e) => setToolCredField(listing.id, key, e.target.value)}
                                  placeholder={field.description || ''}
                                />
                              </label>
                            )
                          })}
                          <p className="edit-tool-cred-hint">Saved credentials are not shown again; enter new values to replace.</p>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
              <p className="edit-tools-panel-hint">Need another tool? <button type="button" className="edit-tools-link-btn" onClick={() => openMarketplace('tools')}>Open marketplace panel</button></p>
            </>
          )}
        </div>

        <div className="edit-kb-section">
          <div className="edit-section-head">
            <h3 className="edit-tools-title">Knowledge base</h3>
            <button type="button" className="edit-marketplace-open-btn" onClick={() => openMarketplace('knowledge')}>
              Add packs from marketplace
            </button>
          </div>
          <p className="edit-kb-hint">Documents you add here are used when the twyn answers questions. PDF and TXT only. Use the panel to attach purchased knowledge packs (multiple files at once).</p>
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
        </div>
      </div>

      {marketplaceOpen && (
        <aside className="edit-market-col" aria-label="Marketplace">
          <div className="edit-market-header">
            <h2 className="edit-market-title">Marketplace</h2>
            <button type="button" className="edit-market-close" onClick={() => setMarketplaceOpen(false)} aria-label="Close marketplace panel">×</button>
          </div>
          <div className="edit-market-tabs">
            <button type="button" className={marketplaceTab === 'tools' ? 'active' : ''} onClick={() => { setMarketplaceTab('tools'); setPanelSelectedPackIds([]); setPackAttachError(null) }}>Tools</button>
            <button type="button" className={marketplaceTab === 'knowledge' ? 'active' : ''} onClick={() => { setMarketplaceTab('knowledge'); setPackAttachError(null) }}>Knowledge packs</button>
          </div>
          <p className="edit-market-intro">
            {marketplaceTab === 'tools'
              ? 'Buy tools or assign ones you already own to this twyn.'
              : 'Buy packs, then select owned packs and add their documents to this twyn’s knowledge base.'}
          </p>
          {marketplaceLoading ? (
            <p className="edit-market-loading">Loading marketplace…</p>
          ) : marketplaceTab === 'tools' ? (
            integrationMarketListings.length === 0 ? (
              <p className="edit-market-empty">No tools in the marketplace yet.</p>
            ) : (
              <ul className="edit-market-list">
                {integrationMarketListings.map((listing) => {
                  const owned = isOwnedId(listing.id)
                  const assigned = assignedIds.includes(listing.id)
                  return (
                    <li key={listing.id} className="edit-market-card">
                      <div className="edit-market-card-top">
                        {listing.logo_url && <img src={listing.logo_url} alt="" className="edit-market-card-logo" />}
                        <div className="edit-market-card-text">
                          <span className="edit-market-card-name">{listing.name}</span>
                          {listing.description && <span className="edit-market-card-desc">{listing.description}</span>}
                        </div>
                      </div>
                      <div className="edit-market-card-actions">
                        {listing.price > 0 && <span className="edit-market-price">${Number(listing.price).toFixed(2)}/mo</span>}
                        {!owned ? (
                          <button
                            type="button"
                            className="edit-market-buy"
                            disabled={panelBuying === listing.id}
                            onClick={() => handlePanelBuy(listing)}
                          >
                            {panelBuying === listing.id ? '…' : listing.price > 0 ? 'Buy' : 'Add free'}
                          </button>
                        ) : (
                          <label className="edit-market-assign">
                            <input
                              type="checkbox"
                              checked={assigned}
                              onChange={() => toggleTool(listing.id)}
                            />
                            <span>Use on this twyn</span>
                          </label>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )
          ) : knowledgeMarketListings.length === 0 ? (
            <p className="edit-market-empty">No knowledge packs in the marketplace yet.</p>
          ) : (
            <>
              <ul className="edit-market-list">
                {knowledgeMarketListings.map((listing) => {
                  const owned = isOwnedId(listing.id)
                  const selected = panelSelectedPackIds.includes(listing.id)
                  return (
                    <li key={listing.id} className="edit-market-card">
                      <div className="edit-market-card-top">
                        {listing.logo_url && <img src={listing.logo_url} alt="" className="edit-market-card-logo" />}
                        <div className="edit-market-card-text">
                          <span className="edit-market-card-name">{listing.name}</span>
                          {listing.knowledge_pack_file_count != null && (
                            <span className="edit-market-card-meta">{listing.knowledge_pack_file_count} documents</span>
                          )}
                          {listing.description && <span className="edit-market-card-desc">{listing.description}</span>}
                        </div>
                      </div>
                      <div className="edit-market-card-actions">
                        {listing.price > 0 && <span className="edit-market-price">${Number(listing.price).toFixed(2)}/mo</span>}
                        {!owned ? (
                          <button
                            type="button"
                            className="edit-market-buy"
                            disabled={panelBuying === listing.id}
                            onClick={() => handlePanelBuy(listing)}
                          >
                            {panelBuying === listing.id ? '…' : listing.price > 0 ? 'Buy' : 'Add free'}
                          </button>
                        ) : (
                          <label className="edit-market-assign">
                            <input
                              type="checkbox"
                              checked={selected}
                              onChange={() => togglePanelPackSelect(listing.id)}
                            />
                            <span>Select to add</span>
                          </label>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
              {panelSelectedPackIds.length > 0 && (
                <div className="edit-market-pack-footer">
                  <button
                    type="button"
                    className="edit-market-add-packs"
                    disabled={packAttachLoading}
                    onClick={handleAddSelectedPacks}
                  >
                    {packAttachLoading ? 'Adding…' : `Add ${panelSelectedPackIds.length} pack(s) to knowledge base`}
                  </button>
                </div>
              )}
              {packAttachError && <p className="edit-market-error">{packAttachError}</p>}
            </>
          )}
        </aside>
      )}

      <style>{`
        .edit-shell { display: flex; align-items: stretch; min-height: 100vh; background: var(--bg-page); width: 100%; }
        .edit-shell--panel .edit-main-col { flex: 1; min-width: 0; border-right: 1px solid var(--border); }
        .edit-main-col { flex: 1; min-width: 0; }
        .edit-page { padding: 2rem; max-width: 560px; margin: 0 auto; background: var(--bg-page); min-height: 100vh; }
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
        .edit-tools-panel-hint { font-size: 0.85rem; color: var(--text-muted); margin: 0.65rem 0 0; }
        .edit-tool-row { display: flex; align-items: center; gap: 0.6rem; padding: 0.6rem 0.75rem; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-card); cursor: pointer; }
        .edit-tool-row:hover { border-color: var(--primary); }
        .edit-tool-row input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; accent-color: var(--primary); }
        .edit-tool-info { display: flex; align-items: center; gap: 0.5rem; }
        .edit-tool-logo { width: 24px; height: 24px; object-fit: contain; }
        .edit-tool-name { font-size: 0.9rem; font-weight: 500; color: var(--text-primary); }
        .edit-tool-block { display: flex; flex-direction: column; gap: 0.35rem; }
        .edit-tool-cred-badge { font-size: 0.7rem; font-weight: 600; color: var(--primary); margin-left: 0.35rem; }
        .edit-tool-creds { margin: 0 0 0.5rem 1.85rem; padding: 0.6rem 0.75rem; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-page); }
        .edit-tool-cred-field { display: block; margin-bottom: 0.6rem; font-size: 0.8rem; color: var(--text-muted); }
        .edit-tool-cred-field input { width: 100%; margin-top: 0.2rem; padding: 0.4rem 0.5rem; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-input); color: var(--text-primary); }
        .edit-tool-cred-hint { margin: 0; font-size: 0.75rem; color: var(--text-muted); }
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
        .edit-section-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem 0.75rem; margin-bottom: 0.6rem; }
        .edit-section-head .edit-tools-title { margin: 0; }
        .edit-marketplace-open-btn { padding: 0.35rem 0.65rem; font-size: 0.8rem; font-weight: 600; border-radius: var(--radius); border: 1px solid var(--primary); background: transparent; color: var(--primary); cursor: pointer; white-space: nowrap; }
        .edit-marketplace-open-btn:hover { background: var(--primary); color: #fff; }
        .edit-tools-empty-sub { font-size: 0.85rem; color: var(--text-muted); margin: 0; }
        .edit-tools-link-btn { align-self: flex-start; background: none; border: none; color: var(--primary); font-weight: 600; cursor: pointer; font-size: 0.9rem; padding: 0; text-align: left; }
        .edit-tools-link-btn:hover { text-decoration: underline; }
        .edit-market-col { width: min(380px, 100%); flex-shrink: 0; padding: 1rem 1rem 2rem; background: var(--bg-card); border-left: 1px solid var(--border); position: sticky; top: 0; align-self: flex-start; max-height: 100vh; overflow-y: auto; }
        .edit-market-header { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.75rem; }
        .edit-market-title { font-family: var(--font-heading); font-size: 1.1rem; font-weight: 700; margin: 0; color: var(--text-primary); }
        .edit-market-close { background: none; border: none; font-size: 1.5rem; line-height: 1; color: var(--text-muted); cursor: pointer; padding: 0 0.25rem; }
        .edit-market-close:hover { color: var(--text-primary); }
        .edit-market-tabs { display: flex; gap: 0.35rem; margin-bottom: 0.75rem; }
        .edit-market-tabs button { flex: 1; padding: 0.4rem 0.5rem; font-size: 0.8rem; font-weight: 600; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-page); color: var(--text-secondary); cursor: pointer; }
        .edit-market-tabs button.active { background: var(--primary); color: #fff; border-color: var(--primary); }
        .edit-market-intro { font-size: 0.8rem; color: var(--text-muted); margin: 0 0 0.75rem; line-height: 1.4; }
        .edit-market-loading, .edit-market-empty { font-size: 0.9rem; color: var(--text-secondary); margin: 0; }
        .edit-market-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.65rem; }
        .edit-market-card { border: 1px solid var(--border); border-radius: var(--radius); padding: 0.65rem 0.75rem; background: var(--bg-page); }
        .edit-market-card-top { display: flex; gap: 0.5rem; align-items: flex-start; }
        .edit-market-card-logo { width: 32px; height: 32px; object-fit: contain; border-radius: 4px; flex-shrink: 0; }
        .edit-market-card-text { display: flex; flex-direction: column; gap: 0.2rem; min-width: 0; }
        .edit-market-card-name { font-weight: 600; font-size: 0.88rem; color: var(--text-primary); }
        .edit-market-card-meta { font-size: 0.75rem; color: var(--text-muted); }
        .edit-market-card-desc { font-size: 0.75rem; color: var(--text-muted); line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
        .edit-market-card-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem; margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid var(--border); }
        .edit-market-price { font-size: 0.8rem; color: var(--text-muted); }
        .edit-market-buy { padding: 0.35rem 0.65rem; font-size: 0.8rem; font-weight: 600; border-radius: var(--radius); border: none; background: var(--primary); color: #fff; cursor: pointer; }
        .edit-market-buy:hover:not(:disabled) { background: var(--primary-hover); }
        .edit-market-buy:disabled { opacity: 0.6; cursor: not-allowed; }
        .edit-market-assign { display: flex; align-items: center; gap: 0.4rem; font-size: 0.85rem; color: var(--text-primary); cursor: pointer; }
        .edit-market-assign input { accent-color: var(--primary); }
        .edit-market-pack-footer { margin-top: 1rem; }
        .edit-market-add-packs { width: 100%; padding: 0.55rem; font-weight: 600; border-radius: var(--radius); border: none; background: var(--primary); color: #fff; cursor: pointer; font-size: 0.88rem; }
        .edit-market-add-packs:hover:not(:disabled) { background: var(--primary-hover); }
        .edit-market-add-packs:disabled { opacity: 0.6; cursor: not-allowed; }
        .edit-market-error { color: var(--error); font-size: 0.85rem; margin: 0.5rem 0 0; }
        @media (max-width: 900px) {
          .edit-shell--panel { flex-direction: column; }
          .edit-shell--panel .edit-main-col { border-right: none; border-bottom: 1px solid var(--border); }
          .edit-market-col { width: 100%; position: relative; max-height: none; border-left: none; border-top: 1px solid var(--border); }
        }
      `}</style>
    </div>
  )
}
