import '../styles/footer.css';
import { useSystemHealthContext } from './SystemHealthContext';

const STATUS_LABEL: Record<string, string> = {
  ok: 'SYSTEM OPERATIONAL',
  degraded: 'SYSTEM DEGRADED',
  down: 'SYSTEM UNREACHABLE',
};

export default function Footer() {
  const health = useSystemHealthContext();

  return (
    <footer className="footer-container" role="contentinfo">
      <div className="footer-content">
        <div className="footer-status">
          <div
            className={`status-indicator status-${health.status}`}
            aria-hidden="true"
          />
          <span className="status-text">
            {STATUS_LABEL[health.status] || 'SYSTEM UNKNOWN'}
          </span>
          <span className="status-meta">
            API {health.backend.toUpperCase()} · DB {health.database.toUpperCase()} · REDIS {health.redis.toUpperCase()}
          </span>
        </div>
        
        <div className="footer-copyright">
          <span className="copyright-text">
            &copy; 2026
          </span>
          <a 
            href="https://xclaw.network" 
            target="_blank" 
            rel="noopener noreferrer"
            className="footer-link"
            aria-label="Visit XClaw Network website"
          >
            XClaw.Network
          </a>
          <span className="copyright-text">
            All rights reserved.
          </span>
        </div>

        <div className="footer-links">
          <a 
            href="https://xclaw.network/privacy" 
            target="_blank" 
            rel="noopener noreferrer"
            className="footer-link"
            aria-label="View Privacy Policy"
          >
            Privacy
          </a>
          <a 
            href="https://xclaw.network/terms" 
            target="_blank" 
            rel="noopener noreferrer"
            className="footer-link"
            aria-label="View Terms of Service"
          >
            Terms
          </a>
          <a 
            href="/manual.html" 
            target="_blank" 
            rel="noopener noreferrer"
            className="footer-link"
            aria-label="View Manual"
          >
            Manual
          </a>
        </div>
      </div>
    </footer>
  );
}
