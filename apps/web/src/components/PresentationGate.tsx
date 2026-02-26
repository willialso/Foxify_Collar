import { useState } from "react";

const ATTICUS_LOGO_URL = "https://i.ibb.co/KpbRyd7w/atticus-copy.png";
const TRAMMELL_LOGO_URL = "https://i.ibb.co/tfGPKyf/tvp-logo.png";

export function PresentationGate({ onAccept }: { onAccept: () => void }) {
  const [atticusFailed, setAtticusFailed] = useState(false);
  const [trammellFailed, setTrammellFailed] = useState(false);

  return (
    <div className="presentation-gate-shell">
      <div className="presentation-gate-card">
        <div className="presentation-gate-logos" aria-label="Atticus and Trammell logos">
          <div className="presentation-gate-logo-slot presentation-gate-logo-slot--atticus">
            {atticusFailed ? (
              <span className="presentation-gate-logo-fallback">Atticus</span>
            ) : (
              <img
                src={ATTICUS_LOGO_URL}
                alt="Atticus logo"
                className="presentation-gate-logo-img presentation-gate-logo-img--atticus"
                onError={() => setAtticusFailed(true)}
              />
            )}
          </div>
          <span className="presentation-gate-separator">&lt;&gt;</span>
          <div className="presentation-gate-logo-slot presentation-gate-logo-slot--trammell">
            {trammellFailed ? (
              <span className="presentation-gate-logo-fallback">Trammell</span>
            ) : (
              <img
                src={TRAMMELL_LOGO_URL}
                alt="Trammell logo"
                className="presentation-gate-logo-img presentation-gate-logo-img--trammell"
                onError={() => setTrammellFailed(true)}
              />
            )}
          </div>
        </div>

        <div className="presentation-gate-copy">
          <p>For TVP internal presentation purposes.</p>
          <p>This preview includes private, sensitive product information.</p>
          <p>Please review confidentially.</p>
        </div>

        <button className="btn btn-primary presentation-gate-cta" onClick={onAccept}>
          Agree & Continue
        </button>
      </div>
    </div>
  );
}
