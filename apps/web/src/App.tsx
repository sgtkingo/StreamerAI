import { useCallback, useEffect, useState } from "react";
import type { ViewerProfile } from "@streamer-ai/contracts";
import {
  apiClient,
  type AuthStatus,
  type ProfileDraft,
  type StreamerApi,
} from "./api/client";
import { AppShell } from "./components/AppShell";
import { DownloadProvider } from "./components/DownloadManager";
import { Brand } from "./components/Brand";
import { ProfileChooser } from "./components/ProfileChooser";
import { Onboarding } from "./components/onboarding/Onboarding";
import { safeErrorMessage } from "./api/client";
import { ThemeProvider } from "./theme/ThemeProvider";
import { AccountLogin } from "./components/AccountLogin";
import { ProfilePinDialog } from "./components/ProfilePin";
import {
  InstallationAccess,
  type InstallationStatus,
} from "./components/InstallationAccess";
import { EncryptedRecovery } from "./components/EncryptedRecovery";

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
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [installation, setInstallation] = useState<InstallationStatus | null>(
    null,
  );
  const [authError, setAuthError] = useState("");
  const [authVersion, setAuthVersion] = useState(0);
  const [lockedProfile, setLockedProfile] = useState<ViewerProfile | null>(
    null,
  );

  const updateProfile = useCallback((updated: ViewerProfile) => {
    setActiveProfile((current) =>
      current?.id === updated.id
        ? { ...current, appearance: updated.appearance }
        : current,
    );
    setProfiles((current) =>
      current.map((item) =>
        item.id === updated.id
          ? { ...item, appearance: updated.appearance }
          : item,
      ),
    );
  }, []);

  const updateProfileDetails = useCallback((updated: ViewerProfile) => {
    setActiveProfile((current) =>
      current?.id === updated.id
        ? { ...updated, appearance: current.appearance }
        : current,
    );
    setProfiles((current) =>
      current.map((item) =>
        item.id === updated.id
          ? { ...updated, appearance: item.appearance }
          : item,
      ),
    );
  }, []);

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
    const initialize = async () => {
      setAuthError("");
      if (api.getInstallationStatus) {
        try {
          const status = await api.getInstallationStatus();
          if (!active) return;
          setInstallation(status);
          if (status.enabled && !status.paired) return;
        } catch {
          if (active)
            setAuthError(
              "The home server cannot be reached. Check its address and try again.",
            );
          return;
        }
      }
      let accountEnabled = false;
      if (api.getAuthStatus) {
        try {
          const status = await api.getAuthStatus();
          if (!active) return;
          setAuth(status);
          accountEnabled = status.enabled;
          if (status.enabled && !status.authenticated) return;
        } catch (reason) {
          if (active) setAuthError(safeErrorMessage(reason));
          return;
        }
      }
      const accountProfiles = accountEnabled ? await loadProfiles() : undefined;
      if (!active) return;
      if (
        accountEnabled &&
        (!accountProfiles || accountProfiles.length === 0)
      ) {
        setSetupState("complete");
        return;
      }
      try {
        const status = await api.getSetupStatus();
        if (!active) return;
        setPlaybackEnabled(status.playback);
        setSetupState(
          status.complete
            ? "complete"
            : accountEnabled
              ? "loading"
              : "required",
        );
        if (status.complete || accountEnabled) {
          const items = accountProfiles ?? (await loadProfiles());
          if (active && items?.length === 0)
            setSetupState(accountEnabled ? "complete" : "required");
          if (active && accountEnabled && !items) setSetupState("complete");
          if (active && !status.complete && items?.length) {
            const initialProfile = items[0]!;
            if (initialProfile.pinEnabled) setSetupState("complete");
            else {
              setRerunProfile(initialProfile);
              setSetupState("required");
            }
          }
        }
      } catch {
        if (active) setSetupState("required");
      }
    };
    void initialize();
    return () => {
      active = false;
    };
  }, [api, forceOnboarding, loadProfiles, authVersion]);

  useEffect(() => {
    const expire = () => {
      setActiveProfile(null);
      setRerunProfile(null);
      setLockedProfile(null);
      setProfiles([]);
      setAuth(null);
      setSetupState("loading");
      setAuthVersion((value) => value + 1);
    };
    window.addEventListener("streamer:auth-required", expire);
    return () => window.removeEventListener("streamer:auth-required", expire);
  }, []);

  useEffect(() => {
    const lock = () => {
      setActiveProfile(null);
      setRerunProfile(null);
      setLockedProfile(null);
      void loadProfiles();
    };
    window.addEventListener("streamer:profile-locked", lock);
    return () => window.removeEventListener("streamer:profile-locked", lock);
  }, [loadProfiles]);

  const signOut = async () => {
    if (!api.logout) return;
    await api.logout();
    setActiveProfile(null);
    setRerunProfile(null);
    setLockedProfile(null);
    setProfiles([]);
    setAuth(null);
    setSetupState("loading");
    setAuthVersion((value) => value + 1);
    window.history.pushState({}, "", "/");
  };

  const selectProfile = (profile: ViewerProfile) => {
    if (profile.pinEnabled) {
      setLockedProfile(profile);
      return;
    }
    if (profile.onboardingComplete) setActiveProfile(profile);
    else setRerunProfile(profile);
  };

  const completeOnboarding = (draft: ProfileDraft) => {
    const selectedId = rerunProfile?.id;
    if (rerunProfile) {
      const completed: ViewerProfile = {
        ...rerunProfile,
        name: draft.name.trim() || "Viewer",
        locale: draft.locale,
        genres: draft.preferences,
        playback: draft.playback,
        appearance: draft.appearance,
        onboardingComplete: true,
      };
      setActiveProfile(completed);
      setProfiles((current) =>
        current.map((item) => (item.id === completed.id ? completed : item)),
      );
    }
    setSetupState("complete");
    setRerunProfile(null);
    void api
      .getSetupStatus(selectedId ?? "default")
      .then((status) => setPlaybackEnabled(status.playback))
      .catch(() => undefined);
    void loadProfiles().then((items) => {
      const updated = items?.find((item) => item.id === selectedId);
      if (updated) setActiveProfile(updated);
    });
  };

  const renderScreen = () => {
    if (!forceOnboarding && installation?.enabled && !installation.paired)
      return (
        <InstallationAccess
          status={installation}
          onConnected={() => {
            setInstallation(null);
            setAuthVersion((version) => version + 1);
          }}
        />
      );
    if (
      !forceOnboarding &&
      (authError || (auth?.enabled && !auth.authenticated))
    ) {
      return (
        <AccountLogin
          api={api}
          allowLocal={auth?.localAvailable ?? true}
          recoveredLocalAccounts={auth?.recoveredLocalAccounts}
          error={authError}
          onRetry={() => setAuthVersion((value) => value + 1)}
          onAuthenticated={() => {
            setAuth(null);
            setSetupState("loading");
            setAuthVersion((value) => value + 1);
          }}
        />
      );
    }
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
          onSignIn={
            auth?.cloudConfigured &&
            auth.account?.cloudLinked === false &&
            api.logout
              ? signOut
              : undefined
          }
          onComplete={completeOnboarding}
        />
      );
    }

    if (!activeProfile) {
      if (profilesLoading && !lockedProfile)
        return (
          <main className="startup-status" aria-live="polite" aria-busy="true">
            <Brand className="brand--loading" />
            <p>Loading profiles…</p>
          </main>
        );
      return (
        <>
          <ProfileChooser
            profiles={profiles}
            error={profilesError}
            onRetry={() => {
              void loadProfiles();
            }}
            onSelect={selectProfile}
            accountName={
              auth?.enabled ? (auth.account?.email ?? undefined) : undefined
            }
            onSignOut={auth?.enabled ? signOut : undefined}
            onCreate={async (name) => {
              const created = await api.createProfile({ name, locale: "en" });
              setProfiles((current) => [...current, created]);
              setRerunProfile(created);
            }}
          />
          {lockedProfile && (
            <ProfilePinDialog
              api={api}
              profile={lockedProfile}
              onCancel={() => setLockedProfile(null)}
              onUnlocked={async () => {
                const items = await loadProfiles();
                const selected = items?.find(
                  (item) => item.id === lockedProfile.id,
                );
                if (!selected) throw new Error("Profile unavailable");
                if (selected.onboardingComplete) setActiveProfile(selected);
                else setRerunProfile(selected);
                setLockedProfile(null);
              }}
            />
          )}
        </>
      );
    }

    return (
      <DownloadProvider
        key={activeProfile.id}
        api={api}
        profileId={activeProfile.id}
      >
        <AppShell
          key={activeProfile.id}
          api={api}
          profile={activeProfile}
          onProfileUpdated={updateProfileDetails}
          onSwitchAccount={() => {
            if (activeProfile.pinEnabled)
              void api.lockProfile?.(activeProfile.id).catch(() => undefined);
            setActiveProfile(null);
            if (auth?.enabled) void loadProfiles();
            window.history.pushState({}, "", "/");
          }}
          onSignOut={auth?.enabled ? signOut : undefined}
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
              .getSetupStatus(activeProfile.id)
              .then((status) => setPlaybackEnabled(status.playback))
              .catch(() => undefined);
          }}
          playbackEnabled={playbackEnabled}
        />
      </DownloadProvider>
    );
  };

  return (
    <ThemeProvider
      api={api}
      profile={activeProfile}
      onProfileUpdated={updateProfile}
    >
      {installation?.role === "owner" && setupState === "required" && (
        <details className="installation-screen">
          <summary>
            Restore an encrypted household instead of starting over
          </summary>
          <EncryptedRecovery />
        </details>
      )}
      {renderScreen()}
    </ThemeProvider>
  );
}

function BrandLoading() {
  return <Brand className="brand--loading" />;
}
