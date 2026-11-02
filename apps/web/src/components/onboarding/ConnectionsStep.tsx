import type { ConnectionState, StreamerApi } from "../../api/client";
import { IntegrationManager } from "../IntegrationManager";

interface ConnectionsStepProps {
  api: StreamerApi;
  profileId: string;
  initialTmdbState: ConnectionState;
  initialWebshareState: ConnectionState;
  onTmdbConnected: () => void;
  onWebshareConnected: () => void;
  onTmdbDisconnected: () => void;
  onWebshareDisconnected: () => void;
}

export function ConnectionsStep({
  api,
  profileId,
  initialTmdbState,
  initialWebshareState,
  onTmdbConnected,
  onWebshareConnected,
  onTmdbDisconnected,
  onWebshareDisconnected,
}: ConnectionsStepProps) {
  return (
    <div className="step-copy">
      <p className="eyebrow">Bring your services</p>
      <h1 tabIndex={-1}>
        Connect once.
        <br />
        We handle the rest.
      </h1>
      <p className="step-lead">
        Services already connected to your account are ready to use. Choose
        additional databases, video sources and subtitle services below. You can
        manage shared connections later in Settings.
      </p>
      <IntegrationManager
        api={api}
        context="onboarding"
        profileId={profileId}
        initialTmdbState={initialTmdbState}
        initialWebshareState={initialWebshareState}
        onConnectionChange={(id, connected) => {
          if (id === "tmdb") {
            if (connected) onTmdbConnected();
            else onTmdbDisconnected();
          }
          if (id === "webshare") {
            if (connected) onWebshareConnected();
            else onWebshareDisconnected();
          }
        }}
      />
      <p className="privacy-line">
        <span aria-hidden="true">◆</span> Credentials are verified by your home
        server and are never saved in browser storage.
      </p>
    </div>
  );
}
