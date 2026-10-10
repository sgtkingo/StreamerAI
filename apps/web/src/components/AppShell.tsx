import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CatalogTitle,
  EpisodeSelection,
  PlaybackGrant,
  ViewerProfile,
} from "@streamer-ai/contracts";
import type { StreamerApi } from "../api/client";
import { Brand } from "./Brand";
import { HomePage } from "./HomePage";
import { LibraryPage } from "./LibraryPage";
import { ProfilePages, type ProfilePage } from "./ProfilePages";
import { VideoPlayer } from "./VideoPlayer";
import { TitleDetail } from "./TitleDetail";

type Route = "home" | "library" | ProfilePage;

function routeFromLocation(): Route {
  const path = window.location.pathname.slice(1);
  return [
    "library",
    "settings",
    "preferences",
    "account",
    "statistics",
  ].includes(path)
    ? (path as Route)
    : "home";
}

export function AppShell({
  api,
  profile,
  onProfileUpdated,
  onSwitchAccount,
  onDeleteProfile,
  onRerunOnboarding,
  onIntegrationsChanged,
  playbackEnabled = false,
}: {
  api: StreamerApi;
  profile: ViewerProfile;
  onProfileUpdated: (profile: ViewerProfile) => void;
  onSwitchAccount: () => void;
  onDeleteProfile: () => Promise<void>;
  onRerunOnboarding: () => void;
  onIntegrationsChanged: () => void;
  playbackEnabled?: boolean;
}) {
  const [route, setRoute] = useState<Route>(routeFromLocation);
  const [homeVisit, setHomeVisit] = useState(0);
  const [libraryVersion, setLibraryVersion] = useState(0);
  const [activePlayback, setActivePlayback] = useState<{
    title: CatalogTitle;
    grant: PlaybackGrant;
    episode?: EpisodeSelection;
    episodeTitle?: string;
  } | null>(null);
  const [playbackClosing, setPlaybackClosing] = useState(false);
  const [detailTitle, setDetailTitle] = useState<CatalogTitle | null>(null);
  const [detailEpisode, setDetailEpisode] = useState<EpisodeSelection | null>(
    null,
  );
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const profileId = profile.id;
  const closeDetail = useCallback(() => {
    setDetailTitle(null);
    setDetailEpisode(null);
    setLibraryVersion((value) => value + 1);
  }, []);
  const openDetail = useCallback(
    (title: CatalogTitle, episode?: EpisodeSelection) => {
      setDetailTitle(title);
      setDetailEpisode(episode ?? null);
    },
    [],
  );
  const playFromDetail = useCallback(
    async (
      title: CatalogTitle,
      episode?: EpisodeSelection,
      episodeTitle?: string,
      sourceId?: string,
    ) => {
      const response = sourceId
        ? await api.preparePlayback(profileId, title.id, episode, sourceId)
        : await api.preparePlayback(profileId, title.id, episode);
      setPlaybackClosing(false);
      setActivePlayback({
        title,
        grant: response.playback,
        episode,
        episodeTitle,
      });
    },
    [api, profileId],
  );

  useEffect(() => {
    const update = () => setRoute(routeFromLocation());
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);

  useEffect(() => {
    if (!profileMenuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!profileMenuRef.current?.contains(event.target as Node))
        setProfileMenuOpen(false);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProfileMenuOpen(false);
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeEscape);
    };
  }, [profileMenuOpen]);

  const navigate = (next: Route) => {
    window.history.pushState({}, "", next === "home" ? "/" : `/${next}`);
    if (next === "home") setHomeVisit((visit) => visit + 1);
    setRoute(next);
    setProfileMenuOpen(false);
    window.scrollTo({ top: 0, behavior: next === "home" ? "auto" : "smooth" });
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <button
          className="brand-button"
          type="button"
          onClick={() => navigate("home")}
          aria-label="StreamerAI home"
        >
          <Brand />
        </button>
        <nav aria-label="Primary navigation" className="primary-nav">
          <button
            type="button"
            className={route === "home" ? "is-active" : ""}
            aria-current={route === "home" ? "page" : undefined}
            onClick={() => navigate("home")}
          >
            Home
          </button>
          <button
            type="button"
            className={route === "library" ? "is-active" : ""}
            aria-current={route === "library" ? "page" : undefined}
            onClick={() => navigate("library")}
          >
            Library
          </button>
        </nav>
        {route === "home" && (
          <nav aria-label="Home sections" className="section-nav">
            <a href="#continue-watching">Continue</a>
            <a href="#new-releases">New</a>
            <a href="#trending">Trending</a>
            <a href="#top-rated">Top Rated</a>
            <a href="#for-you">For You</a>
          </nav>
        )}
        <div className="profile-menu-anchor" ref={profileMenuRef}>
          <button
            className="avatar avatar--button"
            type="button"
            aria-label={`Profile menu for ${profile.name}`}
            aria-expanded={profileMenuOpen}
            aria-haspopup="menu"
            onClick={() => setProfileMenuOpen((open) => !open)}
          >
            {profile.name.slice(0, 1).toUpperCase()}
          </button>
          {profileMenuOpen && (
            <div className="profile-menu" role="menu" aria-label="Profile menu">
              <strong>{profile.name}</strong>
              <button
                role="menuitem"
                type="button"
                onClick={() => navigate("settings")}
              >
                Settings
              </button>
              <button
                role="menuitem"
                type="button"
                onClick={() => navigate("preferences")}
              >
                Preferences
              </button>
              <button
                role="menuitem"
                type="button"
                onClick={() => navigate("account")}
              >
                My account
              </button>
              <button
                role="menuitem"
                type="button"
                onClick={() => navigate("statistics")}
              >
                Statistics
              </button>
              <span className="profile-menu__divider" aria-hidden="true" />
              <button
                className="profile-menu__switch-profile"
                role="menuitem"
                type="button"
                onClick={() => {
                  setProfileMenuOpen(false);
                  onSwitchAccount();
                }}
              >
                Log out / Switch profile
              </button>
            </div>
          )}
        </div>
      </header>

      {route === "home" ? (
        <HomePage
          key={`${profileId}:${homeVisit}`}
          api={api}
          profileId={profileId}
          locale={profile.locale}
          playbackPreferences={profile.playback}
          version={libraryVersion}
          onLibraryChanged={() => setLibraryVersion((value) => value + 1)}
          onOpenTitle={openDetail}
          onPlaybackReady={(title, grant, episode) =>
            setActivePlayback({ title, grant, episode })
          }
        />
      ) : route === "library" ? (
        <LibraryPage
          api={api}
          profileId={profileId}
          playbackPreferences={profile.playback}
          version={libraryVersion}
          onBackHome={() => navigate("home")}
          onOpenTitle={openDetail}
          playbackEnabled={playbackEnabled}
          onPlaybackReady={(title, grant, episode) =>
            setActivePlayback({ title, grant, episode })
          }
        />
      ) : (
        <ProfilePages
          key={`${profile.id}:${route}`}
          page={route}
          api={api}
          profile={profile}
          onProfileUpdated={onProfileUpdated}
          onRerunOnboarding={onRerunOnboarding}
          onIntegrationsChanged={onIntegrationsChanged}
          onSwitchAccount={onSwitchAccount}
          onDeleteProfile={onDeleteProfile}
          onBackHome={() => navigate("home")}
        />
      )}
      {detailTitle && (
        <TitleDetail
          key={`${detailTitle.id}:${detailEpisode?.seasonNumber ?? "series"}:${detailEpisode?.episodeNumber ?? "all"}`}
          api={api}
          profileId={profileId}
          title={detailTitle}
          initialEpisode={detailEpisode ?? undefined}
          playbackEnabled={playbackEnabled}
          suspended={activePlayback !== null && !playbackClosing}
          onClose={closeDetail}
          onOpenRelated={openDetail}
          onPlay={playFromDetail}
          onAdded={() => setLibraryVersion((value) => value + 1)}
        />
      )}
      {activePlayback && (
        <VideoPlayer
          key={activePlayback.grant.grantId}
          api={api}
          profileId={profileId}
          title={activePlayback.title}
          grant={activePlayback.grant}
          episode={activePlayback.episode}
          episodeTitle={activePlayback.episodeTitle}
          preferences={profile.playback}
          onPlayEpisode={(episode, episodeTitle) =>
            playFromDetail(activePlayback.title, episode, episodeTitle)
          }
          onClosing={() => setPlaybackClosing(true)}
          onClose={() => {
            setPlaybackClosing(false);
            setActivePlayback(null);
            setLibraryVersion((value) => value + 1);
          }}
        />
      )}
    </div>
  );
}
