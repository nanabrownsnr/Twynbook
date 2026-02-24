import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { setSession } from '../auth'

const API = '/api'

export default function Signup() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(null)
    if (password !== confirm) { setError('Passwords do not match'); return }
    if (password.length < 6) { setError('Password must be at least 6 characters'); return }
    setLoading(true)
    try {
      const res = await fetch(`${API}/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Signup failed')
      setSession(data.token, data.user)
      navigate('/app', { replace: true })
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <Link to="/" className="auth-logo">TwynBook</Link>
        <h1 className="auth-title">Create your account</h1>
        <p className="auth-subtitle">Get started with TwynBook</p>
        {error && <p className="auth-error">{error}</p>}
        <form onSubmit={handleSubmit} className="auth-form">
          <label className="auth-label">
            Name
            <input
              type="text"
              className="auth-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              placeholder="Your name"
            />
          </label>
          <label className="auth-label">
            Email
            <input
              type="email"
              className="auth-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="you@example.com"
            />
          </label>
          <label className="auth-label">
            Password
            <input
              type="password"
              className="auth-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              placeholder="Min. 6 characters"
            />
          </label>
          <label className="auth-label">
            Confirm password
            <input
              type="password"
              className="auth-input"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              placeholder="Repeat password"
            />
          </label>
          <button type="submit" className="auth-btn" disabled={loading}>
            {loading ? 'Creating account…' : 'Create account'}
          </button>
        </form>
        <p className="auth-switch">
          Already have an account?{' '}
          <Link to="/login" className="auth-switch-link">Sign in</Link>
        </p>
      </div>
      <style>{`
        .auth-page { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--bg-page); padding: 1.5rem; }
        .auth-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 2.5rem 2rem; width: 100%; max-width: 400px; box-shadow: var(--shadow); }
        .auth-logo { font-family: var(--font-heading); font-size: 1.3rem; font-weight: 700; color: var(--primary); text-decoration: none; display: block; margin-bottom: 1.5rem; }
        .auth-title { font-family: var(--font-heading); font-size: 1.6rem; font-weight: 700; color: var(--text-primary); margin: 0 0 0.25rem; }
        .auth-subtitle { color: var(--text-secondary); margin: 0 0 1.5rem; font-size: 0.95rem; }
        .auth-error { background: var(--error-bg, #fee); border: 1px solid var(--error, #c00); color: var(--error, #c00); border-radius: var(--radius); padding: 0.6rem 0.75rem; font-size: 0.9rem; margin-bottom: 1rem; }
        .auth-form { display: flex; flex-direction: column; gap: 1rem; }
        .auth-label { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.9rem; font-weight: 500; color: var(--text-primary); }
        .auth-input { padding: 0.6rem 0.75rem; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-page); color: var(--text-primary); font-size: 1rem; outline: none; }
        .auth-input:focus { border-color: var(--primary); box-shadow: 0 0 0 2px var(--primary-muted); }
        .auth-btn { padding: 0.75rem; background: var(--primary); color: #fff; border: none; border-radius: var(--radius); font-size: 1rem; font-weight: 600; cursor: pointer; margin-top: 0.25rem; }
        .auth-btn:disabled { opacity: 0.7; cursor: not-allowed; }
        .auth-btn:not(:disabled):hover { background: var(--primary-hover); }
        .auth-switch { margin: 1.25rem 0 0; text-align: center; font-size: 0.9rem; color: var(--text-secondary); }
        .auth-switch-link { color: var(--primary); text-decoration: none; font-weight: 500; }
        .auth-switch-link:hover { text-decoration: underline; }
      `}</style>
    </div>
  )
}
