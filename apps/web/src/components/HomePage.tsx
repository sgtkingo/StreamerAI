import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CatalogTitle,
  EpisodeSelection,
  DiscoveryResponse,
  HomeFeed,
  PlaybackPreferences,
} from "@streamer-ai/contracts";
import type { PlaybackGrant, StreamerApi } from "../api/client";
import { safeErrorMessage } from "../api/client";
import {
  groupDiscoveryResults,
  mergeDiscoveryResults,
} from "../discovery-merge";
import { useToasts } from "./ToastProvider";
import { TitleCard } from "./TitleCard";
import { usePlaybackChecks } from "./usePlaybackChecks";

interface HomePageProps {
  api: StreamerApi;
  profileId: string;
  locale: string;
  playbackPreferences: PlaybackPreferences;
  version?: number;
  onLibraryChanged: () => void;
  onPlaybackReady: (
    item: CatalogTitle,
    grant: PlaybackGrant,
    episode?: EpisodeSelection,
  ) => void;
  onOpenTitle: (item: CatalogTitle, episode?: EpisodeSelection) => void;
}

const searchMessages = [
  "Thinking so hard…",
  "Looking for a good fit…",
  "Checking the details…",
  "Putting your shortlist together…",
];

type DiscoveryUiResponse = DiscoveryResponse;

interface PendingAction {
  titleId: string;
  kind: "play" | "add";
}

interface ConversationTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export function HomePage({
  api,
  profileId,
  locale,
  playbackPreferences,
  version,
  onLibraryChanged,
  onPlaybackReady,
  onOpenTitle,
}: HomePageProps) {
  const [feed, setFeed] = useState<HomeFeed | null>(null);
  const [query, setQuery] = useState("");
  const [chatDraft, setChatDraft] = useState("");
  const [chatPendingMessage, setChatPendingMessage] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [chatSearching, setChatSearching] = useState(false);
  const [chatError, setChatError] = useState("");
  const [result, setResult] = useState<DiscoveryUiResponse | null>(null);
  const [resultQuery, setResultQuery] = useState("");
  const [primaryQuery, setPrimaryQuery] = useState("");
  const [resultPhase, setResultPhase] = useState<"quick" | "deep" | null>(null);
  const [visibleCandidateCount, setVisibleCandidateCount] = useState(3);
  const [isSearching, setIsSearching] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isWakingAgent, setIsWakingAgent] = useState(false);
  const [searchMessageIndex, setSearchMessageIndex] = useState(0);
  const [isLoadingFeed, setIsLoadingFeed] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(
    null,
  );
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const { showToast } = useToasts();
  const requestCounter = useRef(0);
  const searchSerial = useRef(0);
  const activeSearch = useRef<AbortController | null>(null);
  const activeFast = useRef<AbortController | null>(null);
  const fastSerial = useRef(0);
  const dualSearchingRef = useRef(false);
  const activeSearchKey = useRef<string | null>(null);
  const activeChat = useRef<AbortController | null>(null);
  const activeChatKey = useRef<string | null>(null);
  const chatSerial = useRef(0);
  const chatLogRef = useRef<HTMLOListElement>(null);
  const searchProgressRef = useRef<HTMLElement>(null);
  const resultsHeadingRef = useRef<HTMLHeadingElement>(null);
  const scrollToNextResult = useRef(false);
  const playbackChecks = usePlaybackChecks(api, profileId);

  const loadHome = useCallback(async () => {
    try {
      setFeed(await api.getHome(profileId));
      setError("");
    } catch (loadError) {
      setError(safeErrorMessage(loadError));
    } finally {
      setIsLoadingFeed(false);
    }
  }, [api, profileId]);

  useEffect(() => {
    void loadHome();
  }, [loadHome, version]);

  useEffect(() => {
    if (!feed || !window.location.hash) return;
    const target = document.getElementById(
      decodeURIComponent(window.location.hash.slice(1)),
    );
    target?.scrollIntoView({ block: "start" });
  }, [feed]);

  useEffect(() => {
    if (!result) return;
    const count = discoveryTitles(result).length;
    setAnnouncement(
      `${count} validated ${count === 1 ? "title" : "titles"} ready.`,
    );
    if (scrollToNextResult.current) {
      scrollToNextResult.current = false;
      resultsHeadingRef.current?.focus({ preventScroll: true });
      resultsHeadingRef.current?.scrollIntoView?.({
        behavior: "smooth",
        block: "start",
      });
    }
  }, [result]);

  useEffect(() => {
    if (chatOpen && chatLogRef.current) {
      chatLogRef.current.scrollTop = chatLogRef.current.scrollHeight;
    }
  }, [chatOpen, turns, chatSearching]);

  useEffect(() => {
    if (error) {
      showToast(error, "error");
    }
  }, [error, showToast]);

  useEffect(() => {
    if (notice) {
      showToast(notice, "success");
    }
  }, [notice, showToast]);

  useEffect(() => {
    if (!isSearching || isStopping) return;
    if (!result)
      searchProgressRef.current?.scrollIntoView?.({
        behavior: "smooth",
        block: "start",
      });
    const interval = window.setInterval(() => {
      setSearchMessageIndex((index) => (index + 1) % searchMessages.length);
    }, 3_000);
    return () => window.clearInterval(interval);
  }, [isSearching, isStopping, result]);

  useEffect(() => {
    if (!isSearching || !isWakingAgent) return;
    let pending = false;
    const interval = window.setInterval(async () => {
      if (pending) return;
      pending = true;
      try {
        const status = await api.getInferenceResidency(
          activeSearch.current?.signal,
        );
        if (
          status.state === "loaded" &&
          activeSearch.current?.signal.aborted === false
        ) {
          setIsWakingAgent(false);
          setAnnouncement("The local agent is awake and finding your matches.");
        }
      } catch {
        // Keep the wake-up notice until discovery ends if the probe is unavailable.
      } finally {
        pending = false;
      }
    }, 2_000);
    return () => window.clearInterval(interval);
  }, [api, isSearching, isWakingAgent]);

  useEffect(
    () => () => {
      searchSerial.current += 1;
      fastSerial.current += 1;
      activeFast.current?.abort();
      if (activeSearchKey.current) {
        void api
          .cancelDiscovery(profileId, activeSearchKey.current)
          .catch(() => undefined);
      }
      activeSearch.current?.abort();
      chatSerial.current += 1;
      if (activeChatKey.current) {
        void api
          .cancelDiscovery(profileId, activeChatKey.current)
          .catch(() => undefined);
      }
      activeChat.current?.abort();
    },
    [api, profileId],
  );

  const stopSearch = async () => {
    if (isStopping) return;
    searchSerial.current += 1;
    const key = activeSearchKey.current;
    setIsStopping(true);
    setIsWakingAgent(false);
    setAnnouncement("Stopping search…");
    activeSearch.current?.abort();
    try {
      if (key) await api.cancelDiscovery(profileId, key);
      setAnnouncement(
        dualSearchingRef.current
          ? "Deep search stopped. Quick matches remain."
          : "Search stopped.",
      );
    } catch {
      setError("Could not confirm that the search stopped. Please try again.");
      setAnnouncement("Search stop could not be confirmed.");
    } finally {
      activeSearch.current = null;
      activeSearchKey.current = null;
      setIsSearching(false);
      setIsStopping(false);
      setIsWakingAgent(false);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const message = query.trim();
    if (message.length < 2 || activeSearch.current) return;
    const controller = new AbortController();
    const serial = ++searchSerial.current;
    const idempotencyKey = `${Date.now()}-${++requestCounter.current}`;
    const turnId = requestCounter.current;
    const fastTicket = ++fastSerial.current;
    activeFast.current?.abort();
    activeFast.current = null;
    dualSearchingRef.current = false;
    chatSerial.current += 1;
    if (activeChatKey.current) {
      void api
        .cancelDiscovery(profileId, activeChatKey.current)
        .catch(() => undefined);
    }
    activeChat.current?.abort();
    activeChat.current = null;
    activeChatKey.current = null;
    setChatSearching(false);
    setChatOpen(false);
    setChatDraft("");
    setChatPendingMessage("");
    setChatError("");
    setResult(null);
    setResultQuery(message);
    setPrimaryQuery(message);
    setResultPhase(null);
    setVisibleCandidateCount(3);
    setTurns([]);
    activeSearch.current = controller;
    activeSearchKey.current = idempotencyKey;
    setIsSearching(true);
    setIsStopping(false);
    setIsWakingAgent(false);
    setSearchMessageIndex(0);
    setError("");
    setNotice("");
    setAnnouncement("StreamerAI is finding and validating titles.");
    const discoverFast = api.discoverFast;
    if (feed?.mode === "live" && discoverFast) {
      dualSearchingRef.current = true;
      const fastController = new AbortController();
      activeFast.current = fastController;
      const sessionId =
        globalThis.crypto?.randomUUID?.() ??
        `search-${Date.now()}-${turnId}-${Math.random().toString(36).slice(2, 10)}`;
      const request = { profileId, message, sessionId, idempotencyKey };
      let quickResult: DiscoveryResponse | null = null;
      let deepResult: DiscoveryResponse | null = null;
      let quickDone = false;
      let deepDone = false;
      let published = false;
      const publish = () => {
        const next =
          quickResult && deepResult
            ? mergeDiscoveryResults(quickResult, deepResult, message)
            : (deepResult ?? quickResult);
        if (!next) return;
        if (!published) scrollToNextResult.current = true;
        published = true;
        setResult(next);
        setResultPhase(deepResult ? "deep" : "quick");
        setTurns([
          { id: `${sessionId}-user-${turnId}`, role: "user", text: message },
          {
            id: `${sessionId}-assistant-${turnId}`,
            role: "assistant",
            text: next.reply,
          },
        ]);
        setQuery("");
      };
      void discoverFast(request, fastController.signal)
        .then((response) => {
          if (
            fastTicket !== fastSerial.current ||
            fastController.signal.aborted
          )
            return;
          quickResult = response;
          publish();
          setAnnouncement(
            controller.signal.aborted
              ? "Quick suggestions are ready; deep search was stopped."
              : "Quick suggestions are ready; deep search continues.",
          );
        })
        .catch((fastError: unknown) => {
          if (
            fastTicket !== fastSerial.current ||
            fastController.signal.aborted
          )
            return;
          if ((deepDone || controller.signal.aborted) && !deepResult)
            setError(safeErrorMessage(fastError));
          else
            setAnnouncement(
              "Quick search did not return; deep search continues.",
            );
        })
        .finally(() => {
          if (fastTicket !== fastSerial.current) return;
          quickDone = true;
          activeFast.current = null;
        });
      void api
        .discover({ ...request, createSession: true }, controller.signal)
        .then((response) => {
          if (serial !== searchSerial.current || controller.signal.aborted)
            return;
          deepResult = response;
          publish();
          setAnnouncement("Deep search finished; results have been enriched.");
        })
        .catch((deepError: unknown) => {
          if (serial !== searchSerial.current || controller.signal.aborted)
            return;
          if (quickDone && !quickResult) setError(safeErrorMessage(deepError));
          else
            setAnnouncement(
              "Deep search could not finish; quick matches remain.",
            );
        })
        .finally(() => {
          if (serial !== searchSerial.current) return;
          deepDone = true;
          activeSearch.current = null;
          activeSearchKey.current = null;
          setIsSearching(false);
          setIsWakingAgent(false);
        });
      void api
        .getInferenceResidency(controller.signal, true)
        .then((status) => {
          if (
            serial === searchSerial.current &&
            !controller.signal.aborted &&
            status.state === "unloaded"
          ) {
            setIsWakingAgent(true);
          }
        })
        .catch(() => undefined);
      return;
    }
    try {
      if (feed?.mode === "live") {
        try {
          const status = await api.getInferenceResidency(
            controller.signal,
            true,
          );
          if (serial !== searchSerial.current || controller.signal.aborted)
            return;
          if (status.state === "unloaded") {
            setIsWakingAgent(true);
            setAnnouncement("");
          }
        } catch {
          if (serial !== searchSerial.current || controller.signal.aborted)
            return;
          // A failed probe must not prevent discovery.
        }
      }
      const response = await api.discover(
        {
          profileId,
          message,
          idempotencyKey,
        },
        controller.signal,
      );
      setIsWakingAgent(false);
      if (serial !== searchSerial.current || controller.signal.aborted) return;
      scrollToNextResult.current = true;
      setResult(response as DiscoveryUiResponse);
      setResultPhase("deep");
      setTurns([
        {
          id: `${response.sessionId}-user-${requestCounter.current}`,
          role: "user",
          text: message,
        },
        {
          id: `${response.sessionId}-assistant-${requestCounter.current}`,
          role: "assistant",
          text: response.reply,
        },
      ]);
      setQuery("");
    } catch (searchError) {
      if (serial === searchSerial.current && !controller.signal.aborted) {
        setError(safeErrorMessage(searchError));
      }
    } finally {
      if (serial === searchSerial.current) {
        activeSearch.current = null;
        activeSearchKey.current = null;
        setIsSearching(false);
        setIsWakingAgent(false);
      }
    }
  };

  const submitChat = async (event: React.FormEvent) => {
    event.preventDefault();
    const message = chatDraft.trim();
    if (!result || isSearching || activeChat.current || message.length < 2)
      return;
    const controller = new AbortController();
    const serial = ++chatSerial.current;
    const idempotencyKey = `${Date.now()}-${++requestCounter.current}`;
    // A late initial Fast response must never overwrite a refined shortlist.
    fastSerial.current += 1;
    activeFast.current?.abort();
    activeFast.current = null;
    activeChat.current = controller;
    activeChatKey.current = idempotencyKey;
    setChatSearching(true);
    setChatPendingMessage(message);
    setChatDraft("");
    setChatError("");
    try {
      const response = await api.discover(
        {
          profileId,
          message,
          sessionId: result.sessionId,
          idempotencyKey,
        },
        controller.signal,
      );
      if (serial !== chatSerial.current || controller.signal.aborted) return;
      scrollToNextResult.current = true;
      setResult(response);
      setResultQuery(message);
      setResultPhase("deep");
      setVisibleCandidateCount(3);
      setTurns((current) => [
        ...current,
        {
          id: `${response.sessionId}-user-${requestCounter.current}`,
          role: "user",
          text: message,
        },
        {
          id: `${response.sessionId}-assistant-${requestCounter.current}`,
          role: "assistant",
          text: response.reply,
        },
      ]);
      setChatPendingMessage("");
    } catch (chatFailure) {
      if (serial === chatSerial.current && !controller.signal.aborted) {
        setChatError(safeErrorMessage(chatFailure));
        setChatPendingMessage("");
        setChatDraft((current) => current || message);
      }
    } finally {
      if (serial === chatSerial.current) {
        activeChat.current = null;
        activeChatKey.current = null;
        setChatSearching(false);
      }
    }
  };

  const add = async (item: CatalogTitle) => {
    if (pendingAction) return;
    setPendingAction({ titleId: item.id, kind: "add" });
    setError("");
    setNotice("");
    try {
      await api.addToLibrary(profileId, item.id);
      setNotice(`${item.title} was added to your Library.`);
      onLibraryChanged();
      await loadHome();
      setResult((current) =>
        current ? markInLibrary(current, item.id) : current,
      );
    } catch (actionError) {
      setError(safeErrorMessage(actionError));
    } finally {
      setPendingAction(null);
    }
  };

  const play = async (
    item: CatalogTitle,
    episode?: EpisodeSelection,
    sourceId?: string,
  ) => {
    if (pendingAction) return;
    setPendingAction({ titleId: item.id, kind: "play" });
    setError("");
    try {
      const response = sourceId
        ? await api.preparePlayback(profileId, item.id, episode, sourceId)
        : await api.preparePlayback(profileId, item.id, episode);
      onPlaybackReady(item, response.playback, episode);
    } catch (actionError) {
      if (sourceId) setError(safeErrorMessage(actionError));
      else
        playbackChecks.markFailed(item, safeErrorMessage(actionError), episode);
    } finally {
      setPendingAction(null);
    }
  };

  const pendingFor = (item: CatalogTitle) =>
    pendingAction?.titleId === item.id ? pendingAction.kind : undefined;

  const resultMode = result?.mode ?? "preview";
  const displayGroups = result
    ? groupDiscoveryResults(
        result,
        (item) => playbackChecks.stateFor(item.title, item.episode)?.status,
        resultQuery,
      )
    : null;
  const availableResults = displayGroups?.available ?? [];
  const unavailableResults = displayGroups?.unavailable ?? [];
  const checkingResults = displayGroups?.checking ?? [];
  const candidates = [
    ...availableResults,
    ...checkingResults,
    ...unavailableResults,
  ];
  const visibleCandidates = candidates.slice(0, visibleCandidateCount);
  const wakeMessage =
    locale === "cs"
      ? "Ouč, agent usnul. Musím ho vzbudit, počkej chvíli…"
      : "Ouch, the local agent dozed off. Waking it up—hang tight…";
  const chatQuestion =
    locale === "cs"
      ? "Je to podle tvých představ?"
      : locale === "de"
        ? "Ist das, was du dir vorgestellt hast?"
        : "Is this what you had in mind?";

  return (
    <main id="home" className="home-page">
      <section
        className="discovery-composer"
        aria-labelledby="discovery-heading"
      >
        <p className="eyebrow">Conversational discovery</p>
        <h1 id="discovery-heading">What are you in the mood for?</h1>
        <p>
          Describe a feeling, actor, era or the people you are watching with.
        </p>
        <form className="composer-form" onSubmit={submit}>
          <label className="sr-only" htmlFor="discovery-query">
            Ask StreamerAI for a movie or series
          </label>
          <textarea
            id="discovery-query"
            rows={1}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (!isSearching && !isStopping)
                  event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={"Try “an autumn movie with Sandra Bullock”"}
          />
          <button
            className={`composer-submit${isSearching ? " is-searching" : ""}${isStopping ? " is-stopping" : ""}`}
            type={isSearching ? "button" : "submit"}
            onClick={isSearching ? stopSearch : undefined}
            disabled={isStopping || (!isSearching && query.trim().length < 2)}
            aria-label={
              isStopping
                ? "Stopping search"
                : isSearching
                  ? "Stop search"
                  : "Find something"
            }
          >
            <span className="composer-submit__label" aria-hidden={isSearching}>
              <span className="composer-submit__enter" aria-hidden="true">
                ↵
              </span>
            </span>
            <span className="composer-submit__stop" aria-hidden="true" />
            <span className="composer-submit__gleam" aria-hidden="true" />
          </button>
        </form>
        <div className="prompt-examples" aria-label="Example searches">
          {[
            "A clever mystery for tonight",
            "A warm 90s comedy",
            "A complete sci-fi series",
          ].map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => setQuery(example)}
            >
              {example}
            </button>
          ))}
        </div>
      </section>

      {isSearching && (
        <>
          <section
            className="pipeline"
            ref={searchProgressRef}
            aria-live="polite"
            aria-label="Discovery progress"
          >
            <span className="pipeline__dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span className="pipeline__message">
              {isStopping
                ? "Stopping search…"
                : isWakingAgent
                  ? "Waking up StreamerAI…"
                  : searchMessages[searchMessageIndex]}
            </span>
          </section>
          {isWakingAgent && (
            <p className="agent-wake-notice" role="status">
              <span className="agent-wake-notice__spark" aria-hidden="true">
                ✦
              </span>
              {wakeMessage}
            </p>
          )}
        </>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      {result && !isSearching && !chatSearching && displayGroups?.bestMatch && (
        <p className="best-suggestion-intro">
          Best suggestion for <span>“{primaryQuery}”</span>
        </p>
      )}
      {(result || isSearching) && (
        <section
          className="discovery-results"
          aria-labelledby="results-heading"
        >
          <div className="section-heading">
            <div>
              <p className="eyebrow">
                {!result
                  ? "Searching for your matches"
                  : resultPhase === "quick"
                    ? isSearching
                      ? "Quick suggestions · deep search running"
                      : "Quick suggestions"
                    : "StreamerAI answer"}
              </p>
              <h2 id="results-heading" ref={resultsHeadingRef} tabIndex={-1}>
                A considered shortlist
              </h2>
            </div>
            {result?.reply && <p>{result.reply}</p>}
          </div>
          {result?.warnings.map((warning) => (
            <p className="preview-notice" key={warning}>
              {warning}
            </p>
          ))}
          {displayGroups?.bestMatch && (
            <TitleCard
              item={displayGroups.bestMatch.title}
              episode={displayGroups.bestMatch.episode}
              episodeTitle={displayGroups.bestMatch.episodeTitle}
              episodeSynopsis={displayGroups.bestMatch.episodeSynopsis}
              preferences={playbackPreferences}
              onOpen={onOpenTitle}
              reason={displayGroups.bestMatch.reason}
              hero
              onPlay={play}
              onCheck={playbackChecks.check}
              playbackCheck={playbackChecks.stateFor(
                displayGroups.bestMatch.title,
                displayGroups.bestMatch.episode,
              )}
              onAdd={add}
              playbackEnabled={resultMode === "live"}
              pendingAction={pendingFor(displayGroups.bestMatch.title)}
            />
          )}
          {!displayGroups?.bestMatch && isSearching && (
            <div className="shortlist-placeholder" role="status">
              <div className="shortlist-placeholder__art" aria-hidden="true" />
              <div
                className="shortlist-placeholder__content"
                aria-hidden="true"
              >
                <span className="shortlist-placeholder__line shortlist-placeholder__line--eyebrow" />
                <span className="shortlist-placeholder__line shortlist-placeholder__line--title" />
                <span className="shortlist-placeholder__line shortlist-placeholder__line--title-short" />
                <span className="shortlist-placeholder__line shortlist-placeholder__line--description" />
                <span className="shortlist-placeholder__line shortlist-placeholder__line--description-short" />
                <span className="shortlist-placeholder__line shortlist-placeholder__line--button" />
              </div>
              <span className="sr-only">Finding your best match…</span>
            </div>
          )}
          {visibleCandidates.length > 0 && (
            <div
              className="shortlist-alternatives"
              role="group"
              aria-label="More matches"
            >
              {visibleCandidates.map(
                ({ title, reason, episode, episodeTitle, episodeSynopsis }) => (
                  <TitleCard
                    key={title.id}
                    item={title}
                    episode={episode}
                    episodeTitle={episodeTitle}
                    episodeSynopsis={episodeSynopsis}
                    preferences={playbackPreferences}
                    onOpen={onOpenTitle}
                    reason={reason}
                    onPlay={play}
                    onCheck={playbackChecks.check}
                    playbackCheck={playbackChecks.stateFor(title, episode)}
                    onAdd={add}
                    playbackEnabled={resultMode === "live"}
                    pendingAction={pendingFor(title)}
                  />
                ),
              )}
            </div>
          )}
          {result && candidates.length > visibleCandidateCount && (
            <div className="shortlist-more">
              <button
                className="button button--secondary"
                type="button"
                onClick={() => setVisibleCandidateCount((count) => count + 3)}
              >
                Show More
              </button>
            </div>
          )}
          {result &&
            !isSearching &&
            !chatSearching &&
            candidates.length <= visibleCandidateCount &&
            result.stage === "completed" && (
              <p className="shortlist-end">
                Sorry, there are no more suggestions for this search.
              </p>
            )}
        </section>
      )}

      {feed?.mode === "preview" && (
        <p className="preview-notice">
          Preview data is active. Live metadata, ratings and availability
          replace it after provider setup.
        </p>
      )}
      {isLoadingFeed && (
        <p className="empty-inline" role="status">
          Loading your Home sections…
        </p>
      )}
      <div className="home-sections">
        {feed?.sections.map((section) => (
          <section
            id={section.id}
            className="home-section"
            key={section.id}
            aria-labelledby={`${section.id}-heading`}
          >
            <div className="section-heading section-heading--row">
              <div>
                <p className="eyebrow">{section.subtitle}</p>
                <h2 id={`${section.id}-heading`}>{section.title}</h2>
              </div>
              <span className={`freshness freshness--${section.freshness}`}>
                {section.freshness}
              </span>
            </div>
            {section.items.length > 0 ? (
              <div className="title-row">
                {section.items.map((item) => (
                  <TitleCard
                    key={item.id}
                    item={item}
                    preferences={playbackPreferences}
                    onOpen={onOpenTitle}
                    onPlay={play}
                    onCheck={playbackChecks.check}
                    playbackCheck={playbackChecks.stateFor(item)}
                    onAdd={add}
                    playbackEnabled={feed.mode === "live"}
                    pendingAction={pendingFor(item)}
                  />
                ))}
              </div>
            ) : (
              <p className="empty-inline">
                Nothing here yet. Start a title and it will appear
                automatically.
              </p>
            )}
          </section>
        ))}
      </div>
      {result?.mode === "live" &&
        result.stage === "completed" &&
        !isSearching && (
          <aside
            className={`discovery-chat${chatOpen ? " is-open" : ""}`}
            aria-label="StreamerAI chat"
          >
            {chatOpen ? (
              <div className="discovery-chat__panel" id="discovery-chat-panel">
                <div className="discovery-chat__header">
                  <div>
                    <span className="discovery-chat__eyebrow">
                      CURRENT SEARCH
                    </span>
                    <h2>Chat with StreamerAI</h2>
                  </div>
                  <button
                    type="button"
                    className="discovery-chat__close close-icon-button"
                    aria-label="Close chat"
                    onClick={() => setChatOpen(false)}
                  >
                    ×
                  </button>
                </div>
                <ol
                  className="discovery-chat__messages"
                  ref={chatLogRef}
                  aria-label="Discovery conversation"
                >
                  {turns.map((turn) => (
                    <li
                      key={turn.id}
                      className={`conversation-turn conversation-turn--${turn.role}`}
                    >
                      <span>{turn.role === "user" ? "You" : "StreamerAI"}</span>
                      <p>{turn.text}</p>
                    </li>
                  ))}
                  {chatSearching && (
                    <>
                      <li className="conversation-turn conversation-turn--user">
                        <span>You</span>
                        <p>{chatPendingMessage}</p>
                      </li>
                      <li
                        className="conversation-turn conversation-turn--assistant"
                        role="status"
                      >
                        <span>StreamerAI</span>
                        <p className="discovery-chat__typing">
                          Rethinking your picks<span aria-hidden="true">…</span>
                        </p>
                      </li>
                    </>
                  )}
                </ol>
                {chatError && (
                  <p className="discovery-chat__error" role="alert">
                    {chatError}
                  </p>
                )}
                <form className="discovery-chat__form" onSubmit={submitChat}>
                  <label className="sr-only" htmlFor="discovery-chat-input">
                    Reply to StreamerAI
                  </label>
                  <textarea
                    id="discovery-chat-input"
                    rows={2}
                    value={chatDraft}
                    onChange={(event) => setChatDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                    placeholder="Tell me what to change…"
                  />
                  <button
                    type="submit"
                    disabled={chatSearching || chatDraft.trim().length < 2}
                  >
                    Send
                  </button>
                </form>
              </div>
            ) : (
              <button
                type="button"
                className="discovery-chat__bubble"
                aria-expanded="false"
                onClick={() => setChatOpen(true)}
              >
                <span className="discovery-chat__mark" aria-hidden="true">
                  ✦
                </span>
                <span>
                  <strong>StreamerAI</strong>
                  <small>{chatQuestion}</small>
                </span>
                <span
                  className="discovery-chat__bubble-arrow"
                  aria-hidden="true"
                >
                  ↗
                </span>
              </button>
            )}
          </aside>
        )}
    </main>
  );
}

function markInLibrary(
  result: DiscoveryUiResponse,
  titleId: string,
): DiscoveryUiResponse {
  const update = <T extends { title: CatalogTitle }>(item: T): T =>
    item.title.id === titleId
      ? { ...item, title: { ...item.title, inLibrary: true } }
      : item;
  return {
    ...result,
    bestMatch: result.bestMatch ? update(result.bestMatch) : null,
    available: result.available.map(update),
    unavailable: result.unavailable.map(update),
    unverified: result.unverified.map(update),
  };
}

function discoveryTitles(result: DiscoveryUiResponse): CatalogTitle[] {
  const titles = [
    ...(result.bestMatch ? [result.bestMatch.title] : []),
    ...result.available.map((item) => item.title),
    ...result.unavailable.map((item) => item.title),
    ...result.unverified.map((item) => item.title),
  ];
  return [...new Map(titles.map((title) => [title.id, title])).values()];
}
