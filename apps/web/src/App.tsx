import { useCallback, useEffect, useState } from "react";
import type { ViewerProfile } from "@streamer-ai/contracts";
import { apiClient, type ProfileDraft, type StreamerApi } from "./api/client";
import { AppShell } from "./components/AppShell";
import { Brand } from "./components/Brand";
import { ProfileChooser } from "./components/ProfileChooser";
import { Onboarding } from "./components/onboarding/Onboarding";
import { safeErrorMessage } from "./api/client";

export interface AppProps {
  api?: StreamerApi;
  forceOnboarding?: boolean;
}

export function App({ api = apiClient, forceOnboarding = false }: AppProps) {
  const [setupState, setSetupState] = useState<
    "loading" | "required" | "complete"
  >(forceOnboarding ? "required" : "loading");
  const [playbackEnabled, setPlaybackEnabled] = useState(false);
  const [profiles, setProfiles] = useState<ViewerProfile[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(true);
  const [activeProfile, setActiveProfile] = useState<ViewerProfile | null>(
    null,
  );
  const [rerunProfile, setRerunProfile] = useState<ViewerProfile | null>(null);
  const [profilesError, setProfilesError] = useState("");

  const loadProfiles = useCallback(async () => {
    setProfilesLoading(true);
    try {
      const response = await api.getProfiles();
      setProfiles(response.items);
      setProfilesError("");
      return response.items;
    } catch (error) {
      setProfilesError(safeErrorMessage(error));
      return null;
    } finally {
      setProfilesLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (forceOnboarding) return;
    let active = true;
    api
      .getSetupStatus()
      .then((status) => {
        if (!active) return;
        setPlaybackEnabled(status.playback);
        setSetupState(status.complete ? "complete" : "required");
        if (status.complete)
          void loadProfiles().then((items) => {
            if (active && items?.length === 0) setSetupState("required");
          });
      })
      .catch(() => {
        // The server is the only setup authority. If it cannot be reached,
        // onboarding remains available and its actions surface the connection error.
        if (active) setSetupState("required");
      });
    return () => {
      active = false;
    };
  }, [api, forceOnboarding, loadProfiles]);

  const completeOnboarding = (_profile: ProfileDraft) => {
    const selectedId = rerunProfile?.id;
    setSetupState("complete");
    setRerunProfile(null);
    void api
      .getSetupStatus()
      .then((status) => setPlaybackEnabled(status.playback))
      .catch(() => undefined);
    void loadProfiles().then((items) => {
      if (selectedId) {
        setActiveProfile(items?.find((item) => item.id === selectedId) ?? null);
      }
    });
  };

  if (setupState === "loading") {
    return (
      <main className="startup-status" aria-live="polite" aria-busy="true">
        <BrandLoading />
        <p>Connecting to your home server…</p>
      </main>
    );
  }

  if (setupState !== "complete" || rerunProfile) {
    return (
      <Onboarding
        key={rerunProfile?.id ?? "initial"}
        api={api}
        existingProfile={rerunProfile ?? undefined}
        onCancel={rerunProfile ? () => setRerunProfile(null) : undefined}
        onComplete={completeOnboarding}
      />
    );
  }

  if (!activeProfile) {
    if (profilesLoading)
      return (
        <main className="startup-status" aria-live="polite" aria-busy="true">
          <Brand className="brand--loading" />
          <p>Loading profiles…</p>
        </main>
      );
    return (
      <ProfileChooser
        profiles={profiles}
        error={profilesError}
        onRetry={() => {
          void loadProfiles();
        }}
        onSelect={(profile) => {
          if (profile.onboardingComplete) setActiveProfile(profile);
          else setRerunProfile(profile);
        }}
        onCreate={async (name) => {
          const created = await api.createProfile({ name, locale: "en" });
          setProfiles((current) => [...current, created]);
          setRerunProfile(created);
        }}
      />
    );
  }

  return (
    <AppShell
      key={activeProfile.id}
      api={api}
      profile={activeProfile}
      onProfileUpdated={(updated) => {
        setActiveProfile(updated);
        setProfiles((current) =>
          current.map((item) => (item.id === updated.id ? updated : item)),
        );
      }}
      onSwitchAccount={() => {
        setActiveProfile(null);
        window.history.pushState({}, "", "/");
      }}
      onDeleteProfile={async () => {
        await api.deleteProfile(activeProfile.id);
        setProfiles((current) =>
          current.filter((item) => item.id !== activeProfile.id),
        );
        setActiveProfile(null);
        window.history.pushState({}, "", "/");
      }}
      onRerunOnboarding={() => setRerunProfile(activeProfile)}
      onIntegrationsChanged={() => {
        void api
          .getSetupStatus()
          .then((status) => setPlaybackEnabled(status.playback))
          .catch(() => undefined);
      }}
      playbackEnabled={playbackEnabled}
    />
  );
}

function BrandLoading() {
  return <Brand className="brand--loading" />;
}
