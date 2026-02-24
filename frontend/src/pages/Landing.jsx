import { Link } from 'react-router-dom'
import { getToken } from '../auth'

export default function Landing() {
  const isLoggedIn = !!getToken()
  return (
    <div className="landing">
      <div className="landing-content">
        <h1 className="landing-title">Welcome to TwynBook</h1>
        <p className="landing-tagline">
          Create a digital twin that can manage your online life.
        </p>
        <p className="landing-desc">
          Your AI-powered twyn looks and sounds like you. Chat with your twin, let it handle tasks, and keep your presence consistent—all in one place.
        </p>
        {isLoggedIn ? (
          <Link to="/app" className="landing-cta">Go to my twyns</Link>
        ) : (
          <div className="landing-actions">
            <Link to="/signup" className="landing-cta">Get started</Link>
            <Link to="/login" className="landing-cta-secondary">Sign in</Link>
          </div>
        )}
      </div>
      <p className="landing-by">by 4th-ir</p>
      <style>{`
        .landing {
          position: relative;
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 2rem;
          text-align: center;
          background: var(--bg-page);
          color: var(--text-primary);
        }
        .landing-content { max-width: 480px; }
        .landing-title {
          font-family: var(--font-heading);
          font-size: clamp(1.75rem, 5vw, 2.25rem);
          font-weight: 700;
          margin: 0 0 0.75rem;
          letter-spacing: -0.02em;
          color: var(--text-primary);
        }
        .landing-tagline {
          font-size: 1.25rem;
          font-weight: 600;
          color: var(--primary);
          margin: 0 0 1rem;
          line-height: 1.35;
        }
        .landing-desc {
          font-size: 1rem;
          line-height: 1.6;
          color: var(--text-secondary);
          margin: 0 0 2rem;
        }
        .landing-actions { display: flex; gap: 0.75rem; justify-content: center; flex-wrap: wrap; }
        .landing-cta {
          display: inline-block;
          padding: 0.875rem 2rem;
          font-size: 1.05rem;
          font-weight: 600;
          color: #fff;
          background: var(--primary);
          border-radius: var(--radius-lg);
          text-decoration: none;
          transition: background 0.2s, transform 0.1s;
          box-shadow: 0 2px 8px rgba(124, 58, 237, 0.35);
        }
        .landing-cta:hover {
          background: var(--primary-hover);
          text-decoration: none;
          transform: translateY(-1px);
        }
        .landing-cta-secondary {
          display: inline-block;
          padding: 0.875rem 2rem;
          font-size: 1.05rem;
          font-weight: 600;
          color: var(--primary);
          background: transparent;
          border: 2px solid var(--primary);
          border-radius: var(--radius-lg);
          text-decoration: none;
          transition: background 0.2s, transform 0.1s;
        }
        .landing-cta-secondary:hover {
          background: var(--primary-muted);
          text-decoration: none;
          transform: translateY(-1px);
        }
        .landing-by {
          position: absolute;
          bottom: 1.5rem;
          left: 50%;
          transform: translateX(-50%);
          font-size: 0.875rem;
          color: var(--text-muted);
        }
      `}</style>
    </div>
  )
}
