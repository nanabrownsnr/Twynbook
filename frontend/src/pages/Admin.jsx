import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch, getUser } from '../auth'

const API = '/api'

export default function Admin() {
  const user = getUser()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    apiFetch(`${API}/admin/dashboard`)
      .then((r) => {
        if (!r.ok) {
          if (r.status === 403) throw new Error('Admin access required')
          throw new Error(r.statusText || 'Failed to load')
        }
        return r.json()
      })
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (user?.is_admin !== true) {
    return (
      <div className="admin-page">
        <header className="admin-header">
          <Link to="/app" className="admin-back">← Back to app</Link>
          <h1 className="admin-title">Admin</h1>
        </header>
        <p className="admin-forbidden">You don’t have access to this page.</p>
      </div>
    )
  }

  if (loading) return <div className="admin-page"><p className="admin-loading">Loading…</p></div>
  if (error) return <div className="admin-page"><p className="admin-error">Error: {error}</p></div>
  if (!data) return null

  const { users = [], totals = {} } = data

  return (
    <div className="admin-page">
      <header className="admin-header">
        <div className="admin-header-left">
          <Link to="/app" className="admin-back">← Back to app</Link>
          <h1 className="admin-title">Admin panel</h1>
          <p className="admin-tagline">Users, personas, and purchases</p>
        </div>
      </header>

      <div className="admin-totals">
        <div className="admin-total-card">
          <span className="admin-total-value">{totals.users ?? 0}</span>
          <span className="admin-total-label">Users</span>
        </div>
        <div className="admin-total-card">
          <span className="admin-total-value">{totals.personas ?? 0}</span>
          <span className="admin-total-label">Personas (twyns)</span>
        </div>
        <div className="admin-total-card">
          <span className="admin-total-value">{totals.purchases ?? 0}</span>
          <span className="admin-total-label">Purchases</span>
        </div>
      </div>

      <div className="admin-section">
        <h2 className="admin-section-title">Users</h2>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Signed up</th>
                <th>Admin</th>
                <th>Personas</th>
                <th>Purchases</th>
                <th>Purchased items</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="admin-cell-email">{u.email}</td>
                  <td>{u.name || '—'}</td>
                  <td className="admin-cell-date">{u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}</td>
                  <td>{u.is_admin ? 'Yes' : '—'}</td>
                  <td className="admin-cell-num">{u.persona_count ?? 0}</td>
                  <td className="admin-cell-num">{u.purchase_count ?? 0}</td>
                  <td className="admin-cell-list">{u.purchases?.length ? u.purchases.join(', ') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <style>{`
        .admin-page { padding: 2rem; max-width: 1100px; margin: 0 auto; min-height: 100vh; background: var(--bg-page); }
        .admin-header { margin-bottom: 2rem; }
        .admin-back { display: inline-block; margin-bottom: 0.5rem; color: var(--primary); font-size: 0.95rem; }
        .admin-back:hover { text-decoration: none; }
        .admin-title { font-family: var(--font-heading); font-size: 1.5rem; font-weight: 700; margin: 0 0 0.25rem; color: var(--text-primary); }
        .admin-tagline { font-size: 0.95rem; color: var(--text-muted); margin: 0; }
        .admin-loading, .admin-error, .admin-forbidden { padding: 2rem 0; color: var(--text-secondary); }
        .admin-error { color: var(--error, #c00); }
        .admin-totals { display: flex; gap: 1rem; margin-bottom: 2rem; flex-wrap: wrap; }
        .admin-total-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 1.25rem 1.5rem; min-width: 120px; }
        .admin-total-value { display: block; font-size: 1.75rem; font-weight: 700; color: var(--primary); }
        .admin-total-label { font-size: 0.85rem; color: var(--text-muted); }
        .admin-section { margin-bottom: 2rem; }
        .admin-section-title { font-size: 1.1rem; font-weight: 600; margin: 0 0 1rem; color: var(--text-primary); }
        .admin-table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-card); }
        .admin-table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
        .admin-table th, .admin-table td { padding: 0.6rem 0.75rem; text-align: left; border-bottom: 1px solid var(--border); }
        .admin-table th { font-weight: 600; color: var(--text-muted); background: var(--bg-page); }
        .admin-table tr:last-child td { border-bottom: none; }
        .admin-table tbody tr:hover { background: var(--bg-page); }
        .admin-cell-email { font-family: monospace; font-size: 0.85rem; }
        .admin-cell-date { white-space: nowrap; }
        .admin-cell-num { text-align: right; }
        .admin-cell-list { max-width: 220px; font-size: 0.85rem; color: var(--text-secondary); }
      `}</style>
    </div>
  )
}
