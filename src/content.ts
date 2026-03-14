/// <reference types="chrome" />

import jumpscareData from "./jumpscares.json";

type WindowWithJumpscareFlags = Window & {
  __jumpscareContentScriptInstalled?: boolean;
};

type ExtensionSettings = {
  warn: boolean;
  mute: boolean;
  skip: boolean;
  timer: number;
};

type PlaybackState = {
  title: string | null;
  currentTime: number | null;
  secondsToNextScare: number | null;
  hasVideo: boolean;
  url: string;
};

type ActiveMuteState = {
  scareTime: number;
  restoreMuted: boolean;
  video: HTMLVideoElement;
};

type JumpscareEntry = {
  time_stamps?: string[];
};

const windowWithFlags = window as WindowWithJumpscareFlags;

if (!windowWithFlags.__jumpscareContentScriptInstalled) {
  windowWithFlags.__jumpscareContentScriptInstalled = true;

  console.log("[JumpsCare] content script loaded");

  const DEFAULT_SETTINGS: ExtensionSettings = {
    warn: false,
    mute: false,
    skip: false,
    timer: 3
  };
  const MOVIE_TITLES = Object.keys(jumpscareData);
  const BRIDGE_MESSAGE_SOURCE = "__JUMPSCARE_NETFLIX_BRIDGE__";
  const BRIDGE_SCRIPT_ID = "jumpscare-netflix-player-bridge";
  const SKIP_BEFORE_SECONDS = 5;
  const SKIP_AFTER_SECONDS = 3;
  const MUTE_BEFORE_SECONDS = 2;
  const MUTE_AFTER_SECONDS = 2;
  const SEEK_BACK_RESET_THRESHOLD = 8;
  const ACTION_LOCK_MS = 1500;
  const TITLE_SELECTORS = [
    "[data-uia='video-title']",
    "[data-uia='player-title']",
    "[data-uia='video-title-title']",
    ".player-status-main-title",
    ".watch-video--player-view .ellipsize-text h4",
    ".video-title",
    "meta[property='og:title']",
    "h1"
  ];
  const VISIBLE_TIME_SELECTORS = [
    "[data-uia='current-time']",
    "[data-uia='player-current-time']",
    "[data-uia='media-current-time']",
    "[data-uia='elapsed-time']"
  ];
  const VIDEO_EVENTS: Array<keyof HTMLMediaElementEventMap> = [
    "timeupdate",
    "seeking",
    "seeked",
    "play",
    "pause",
    "ratechange",
    "loadedmetadata",
    "durationchange"
  ];

  let settings: ExtensionSettings = DEFAULT_SETTINGS;
  let currentTitle: string | null = null;
  let matchedMovieTitle: string | null = null;
  let jumpscareTimes: number[] = [];
  let trackedVideo: HTMLVideoElement | null = null;
  let lastPublishedSecond = -1;
  let lastKnownUrl = location.href;
  let bridgeTimeSeconds: number | null = null;
  let bridgeTimeUpdatedAt = 0;
  let bridgeInjected = false;
  let activeMute: ActiveMuteState | null = null;
  let skippedScares = new Set<number>();
  let mutedScares = new Set<number>();
  let lastAutomationTime: number | null = null;
  let actionLockedUntil = 0;

  function normalizeTitle(value: string): string {
    return value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/&/g, " and ")
      .replace(/[^\w\s]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function scoreTitleMatch(candidate: string, actual: string): number {
    const normalizedCandidate = normalizeTitle(candidate);
    const normalizedActual = normalizeTitle(actual);

    if (!normalizedCandidate || !normalizedActual) {
      return -1;
    }

    if (normalizedCandidate === normalizedActual) {
      return 1000;
    }

    if (
      normalizedCandidate.startsWith(normalizedActual) ||
      normalizedActual.startsWith(normalizedCandidate)
    ) {
      return (
        800 - Math.abs(normalizedCandidate.length - normalizedActual.length)
      );
    }

    if (
      normalizedCandidate.includes(normalizedActual) ||
      normalizedActual.includes(normalizedCandidate)
    ) {
      return (
        600 - Math.abs(normalizedCandidate.length - normalizedActual.length)
      );
    }

    const actualWords = normalizedActual.split(" ");
    const candidateWords = new Set(normalizedCandidate.split(" "));
    const sharedWords = actualWords.filter(word => candidateWords.has(word)).length;

    return sharedWords >= Math.min(2, actualWords.length)
      ? sharedWords * 25 - Math.abs(candidateWords.size - actualWords.length)
      : -1;
  }

  function findBestMovieMatch(movieTitle: string | null): string | null {
    if (!movieTitle) {
      return null;
    }

    let bestMatch: string | null = null;
    let bestScore = -1;

    for (const candidate of MOVIE_TITLES) {
      const score = scoreTitleMatch(candidate, movieTitle);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = candidate;
      }
    }

    return bestScore >= 0 ? bestMatch : null;
  }

  function parseJumpscareSeconds(
    entry: JumpscareEntry | null | undefined
  ): number[] {
    const rawTimestamps = Array.isArray(entry?.time_stamps)
      ? entry.time_stamps
      : [];

    return rawTimestamps
      .map(timestamp => {
        const [hours = 0, minutes = 0, seconds = 0] = timestamp
          .split(":")
          .map(Number);

        return hours * 3600 + minutes * 60 + seconds;
      })
      .filter(Number.isFinite);
  }

  function getMatchedJumpscareTimes(movieTitle: string | null): number[] {
    const matchedTitle = findBestMovieMatch(movieTitle);

    return matchedTitle
      ? parseJumpscareSeconds(
          jumpscareData[matchedTitle as keyof typeof jumpscareData]
        )
      : [];
  }

  function normalizeSettings(
    rawSettings: Partial<ExtensionSettings> | null | undefined
  ): ExtensionSettings {
    return {
      warn: Boolean(rawSettings?.warn),
      mute: Boolean(rawSettings?.mute),
      skip: Boolean(rawSettings?.skip),
      timer: Number.isFinite(Number(rawSettings?.timer))
        ? Number(rawSettings?.timer)
        : DEFAULT_SETTINGS.timer
    };
  }

  function loadSettings(): Promise<ExtensionSettings> {
    return new Promise(resolve => {
      chrome.storage.local.get(DEFAULT_SETTINGS, items => {
        resolve(normalizeSettings(items as Partial<ExtensionSettings>));
      });
    });
  }

  function subscribeToSettings(
    listener: (nextSettings: ExtensionSettings) => void
  ): () => void {
    const handleStorageChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string
    ) => {
      if (areaName !== "local") {
        return;
      }

      if (
        !("warn" in changes) &&
        !("mute" in changes) &&
        !("skip" in changes) &&
        !("timer" in changes)
      ) {
        return;
      }

      void loadSettings().then(listener);
    };

    chrome.storage.onChanged.addListener(handleStorageChange);

    return () => {
      chrome.storage.onChanged.removeListener(handleStorageChange);
    };
  }

  function sendRuntimeMessage(message: Record<string, unknown>): void {
    chrome.runtime.sendMessage(message, () => {
      void chrome.runtime.lastError;
    });
  }

  function isNetflixWatchPage(): boolean {
    return /https?:\/\/(?:www\.)?netflix\.com\/watch\//i.test(location.href);
  }

  function normalizeDetectedTitle(value: string): string {
    return value
      .replace(/\s+/g, " ")
      .replace(/\s*[|-]\s*Netflix.*$/i, "")
      .replace(/^watch\s+/i, "")
      .trim();
  }

  function isMeaningfulTitle(value: string | null): value is string {
    if (!value) {
      return false;
    }

    const normalized = value.toLowerCase().trim();
    if (!normalized) {
      return false;
    }

    return !["netflix", "home", "watch", "browse", "player"].includes(
      normalized
    );
  }

  function getNetflixTitle(): string | null {
    for (const selector of TITLE_SELECTORS) {
      const element = document.querySelector(selector);
      const rawValue =
        element instanceof HTMLMetaElement
          ? element.content
          : element?.textContent ?? null;

      const cleaned = rawValue ? normalizeDetectedTitle(rawValue) : null;
      if (isMeaningfulTitle(cleaned)) {
        return cleaned;
      }
    }

    const fallback = normalizeDetectedTitle(document.title.split("|")[0] ?? "");
    return isMeaningfulTitle(fallback) ? fallback : null;
  }

  function parseClockToSeconds(value: string): number | null {
    const match = value.trim().match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
    if (!match) {
      return null;
    }

    if (match[3] !== undefined) {
      return (
        Number(match[1]) * 3600 +
        Number(match[2]) * 60 +
        Number(match[3])
      );
    }

    return Number(match[1]) * 60 + Number(match[2]);
  }

  function getVisiblePlayerTime(): number | null {
    for (const selector of VISIBLE_TIME_SELECTORS) {
      const element = document.querySelector(selector);
      const rawValue = element?.textContent?.split("/")[0]?.trim();
      if (!rawValue) {
        continue;
      }

      const parsed = parseClockToSeconds(rawValue);
      if (parsed !== null) {
        return parsed;
      }
    }

    return null;
  }

  function hasFreshBridgeTime(): boolean {
    return bridgeTimeSeconds !== null && Date.now() - bridgeTimeUpdatedAt < 4000;
  }

  function getCurrentTime(): number | null {
    if (hasFreshBridgeTime()) {
      return bridgeTimeSeconds;
    }

    if (trackedVideo && Number.isFinite(trackedVideo.currentTime)) {
      return trackedVideo.currentTime;
    }

    return getVisiblePlayerTime();
  }

  function getSecondsToNextScare(currentTime: number | null): number | null {
    if (typeof currentTime !== "number" || !Number.isFinite(currentTime)) {
      return null;
    }

    const nextScare = jumpscareTimes.find(scareTime => scareTime > currentTime);
    return nextScare != null ? Math.ceil(nextScare - currentTime) : null;
  }

  function createPlaybackState(): PlaybackState {
    const currentTime = getCurrentTime();

    return {
      title: currentTitle,
      currentTime,
      secondsToNextScare: getSecondsToNextScare(currentTime),
      hasVideo:
        Boolean(trackedVideo) ||
        document.querySelector("video") instanceof HTMLVideoElement,
      url: location.href
    };
  }

  function publishState(): void {
    sendRuntimeMessage({
      action: "stateUpdate",
      ...createPlaybackState()
    });
  }

  function clearAutoMute(): void {
    if (!activeMute) {
      return;
    }

    try {
      activeMute.video.muted = activeMute.restoreMuted;
    } catch {
      // Ignore restore failures on detached/replaced videos.
    }

    activeMute = null;
  }

  function resetAutomationState(): void {
    clearAutoMute();
    skippedScares = new Set();
    mutedScares = new Set();
    lastAutomationTime = null;
    actionLockedUntil = 0;
  }

  function syncMatchedMovie(): void {
    const nextMatchedTitle = findBestMovieMatch(currentTitle);

    if (nextMatchedTitle === matchedMovieTitle) {
      return;
    }

    matchedMovieTitle = nextMatchedTitle;
    jumpscareTimes = getMatchedJumpscareTimes(currentTitle);
    resetAutomationState();
  }

  function resetTriggeredScaresForSeek(currentTime: number): void {
    skippedScares = new Set(
      [...skippedScares].filter(
        scareTime => scareTime < currentTime - SKIP_BEFORE_SECONDS
      )
    );
    mutedScares = new Set(
      [...mutedScares].filter(
        scareTime => scareTime < currentTime - MUTE_BEFORE_SECONDS
      )
    );
    clearAutoMute();
  }

  function seekVideoTo(targetTime: number): void {
    if (!trackedVideo) {
      return;
    }

    try {
      if (typeof trackedVideo.fastSeek === "function") {
        trackedVideo.fastSeek(targetTime);
      }
      trackedVideo.currentTime = targetTime;
    } catch {
      // Ignore seek failures and let the next scan retry from live state.
    }
  }

  function triggerSkip(scareTime: number): void {
    const targetTime = scareTime + SKIP_AFTER_SECONDS;

    skippedScares.add(scareTime);
    mutedScares.add(scareTime);
    clearAutoMute();
    actionLockedUntil = Date.now() + ACTION_LOCK_MS;
    bridgeTimeSeconds = targetTime;
    bridgeTimeUpdatedAt = Date.now();
    lastAutomationTime = targetTime;

    seekVideoTo(targetTime);
    publishCurrentTime(true);
  }

  function triggerMute(scareTime: number): void {
    if (!trackedVideo || (activeMute && activeMute.scareTime === scareTime)) {
      return;
    }

    clearAutoMute();

    activeMute = {
      scareTime,
      restoreMuted: trackedVideo.muted,
      video: trackedVideo
    };
    mutedScares.add(scareTime);

    trackedVideo.muted = true;
  }

  function evaluateAutomation(currentTime: number | null): void {
    if (typeof currentTime !== "number" || !Number.isFinite(currentTime)) {
      if (!settings.warn || !settings.mute) {
        clearAutoMute();
      }
      return;
    }

    if (
      lastAutomationTime !== null &&
      currentTime < lastAutomationTime - SEEK_BACK_RESET_THRESHOLD
    ) {
      resetTriggeredScaresForSeek(currentTime);
    }
    lastAutomationTime = currentTime;

    if (!settings.warn || jumpscareTimes.length === 0) {
      clearAutoMute();
      return;
    }

    if (activeMute) {
      const inMuteWindow =
        currentTime >= activeMute.scareTime - MUTE_BEFORE_SECONDS &&
        currentTime < activeMute.scareTime + MUTE_AFTER_SECONDS;

      if (!settings.mute || !inMuteWindow) {
        clearAutoMute();
      }
    }

    if (trackedVideo?.paused || Date.now() < actionLockedUntil) {
      return;
    }

    if (settings.skip) {
      const scareToSkip = jumpscareTimes.find(
        scareTime =>
          !skippedScares.has(scareTime) &&
          currentTime >= scareTime - SKIP_BEFORE_SECONDS &&
          currentTime < scareTime + SKIP_AFTER_SECONDS
      );

      if (scareToSkip !== undefined) {
        triggerSkip(scareToSkip);
        return;
      }
    }

    if (settings.mute) {
      const scareToMute = jumpscareTimes.find(
        scareTime =>
          !mutedScares.has(scareTime) &&
          currentTime >= scareTime - MUTE_BEFORE_SECONDS &&
          currentTime < scareTime + MUTE_AFTER_SECONDS
      );

      if (scareToMute !== undefined) {
        triggerMute(scareToMute);
      }
    }
  }

  function publishTitle(force = false): void {
    const detectedTitle = getNetflixTitle();

    if (!detectedTitle && currentTitle) {
      if (force) {
        publishState();
      }
      return;
    }

    const nextTitle = detectedTitle;
    if (!force && nextTitle === currentTitle) {
      return;
    }

    currentTitle = nextTitle;
    syncMatchedMovie();

    sendRuntimeMessage({
      action: "titleUpdate",
      title: currentTitle
    });
    publishState();
  }

  function publishCurrentTime(force = false): void {
    const nextTime = getCurrentTime();
    if (nextTime === null) {
      if (force || lastPublishedSecond !== -1) {
        lastPublishedSecond = -1;
        publishState();
      }
      evaluateAutomation(nextTime);
      return;
    }

    const nextSecond = Math.floor(nextTime);
    if (!force && nextSecond === lastPublishedSecond) {
      evaluateAutomation(nextTime);
      return;
    }

    lastPublishedSecond = nextSecond;
    sendRuntimeMessage({
      action: "timeUpdate",
      currentTime: nextTime
    });
    publishState();
    evaluateAutomation(nextTime);
  }

  function handleTrackedVideoEvent(): void {
    publishCurrentTime();
  }

  function removeVideoListeners(video: HTMLVideoElement): void {
    for (const eventName of VIDEO_EVENTS) {
      video.removeEventListener(eventName, handleTrackedVideoEvent);
    }
  }

  function addVideoListeners(video: HTMLVideoElement): void {
    for (const eventName of VIDEO_EVENTS) {
      video.addEventListener(eventName, handleTrackedVideoEvent);
    }
  }

  function attachToVideo(): void {
    const videoElement = document.querySelector("video");
    const nextVideo =
      videoElement instanceof HTMLVideoElement ? videoElement : null;

    if (trackedVideo === nextVideo) {
      return;
    }

    if (trackedVideo) {
      clearAutoMute();
      removeVideoListeners(trackedVideo);
    }

    trackedVideo = nextVideo;
    lastPublishedSecond = -1;

    if (trackedVideo) {
      addVideoListeners(trackedVideo);
      console.log("[JumpsCare] attached to video element");
    }

    publishCurrentTime(true);
  }

  function injectPlayerBridge(): void {
    if (
      !isNetflixWatchPage() ||
      bridgeInjected ||
      document.getElementById(BRIDGE_SCRIPT_ID)
    ) {
      return;
    }

    bridgeInjected = true;
    const script = document.createElement("script");
    script.id = BRIDGE_SCRIPT_ID;
    script.src = chrome.runtime.getURL("page-bridge.js");
    script.async = false;
    script.addEventListener("load", () => script.remove());
    script.addEventListener("error", () => {
      bridgeInjected = false;
      script.remove();
    });

    (document.head || document.documentElement).appendChild(script);
  }

  function handleLocationChange(force = false): void {
    if (!force && location.href === lastKnownUrl) {
      return;
    }

    lastKnownUrl = location.href;
    currentTitle = null;
    matchedMovieTitle = null;
    jumpscareTimes = [];
    bridgeTimeSeconds = null;
    bridgeTimeUpdatedAt = 0;
    resetAutomationState();

    attachToVideo();
    publishTitle(true);
    publishCurrentTime(true);
  }

  function scanPage(force = false): void {
    if (location.href !== lastKnownUrl) {
      handleLocationChange(true);
      return;
    }

    attachToVideo();
    publishTitle(force);
    publishCurrentTime(force);
    injectPlayerBridge();
  }

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) {
      return;
    }

    const data = event.data as
      | {
          source?: string;
          action?: string;
          currentTimeMs?: number;
        }
      | undefined;

    if (
      !data ||
      data.source !== BRIDGE_MESSAGE_SOURCE ||
      data.action !== "playerTime" ||
      typeof data.currentTimeMs !== "number" ||
      !Number.isFinite(data.currentTimeMs)
    ) {
      return;
    }

    bridgeTimeSeconds = data.currentTimeMs / 1000;
    bridgeTimeUpdatedAt = Date.now();
    publishCurrentTime();
  });

  chrome.runtime.onMessage.addListener(
    (
      message: { action?: string },
      _sender,
      sendResponse: (
        response?: PlaybackState | { title: string | null }
      ) => void
    ) => {
      if (message.action === "getState") {
        scanPage();
        sendResponse(createPlaybackState());
      }

      if (message.action === "getTitle") {
        publishTitle();
        sendResponse({ title: currentTitle });
      }
    }
  );

  const observer = new MutationObserver(() => {
    scanPage();
  });

  function startObserver(): void {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  void loadSettings().then(loadedSettings => {
    settings = loadedSettings;
    evaluateAutomation(getCurrentTime());
  });

  const unsubscribeFromSettings = subscribeToSettings(nextSettings => {
    settings = nextSettings;

    if (!settings.warn || !settings.mute) {
      clearAutoMute();
    }

    evaluateAutomation(getCurrentTime());
  });

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        startObserver();
        scanPage(true);
      },
      { once: true }
    );
  } else {
    startObserver();
    scanPage(true);
  }

  window.addEventListener("popstate", () => {
    handleLocationChange(true);
  });

  window.addEventListener("unload", () => {
    clearAutoMute();
    unsubscribeFromSettings();
  });

  window.setInterval(() => {
    scanPage();
  }, 1000);
}
