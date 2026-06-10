/// <reference types="chrome" />

import jumpscareData from "./jumpscares.json";

type WindowWithJumpscareFlags = Window & {
  __jumpscareContentScriptInstalled?: boolean;
};

type ExtensionSettings = {
  enabled: boolean;
  warn: boolean;
  mute: boolean;
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
    enabled: true,
    warn: false,
    mute: false,
    timer: 3
  };
  const actualJumpscareData = (jumpscareData as any).default || jumpscareData;
  const MOVIE_TITLES = Object.keys(actualJumpscareData);
  const BRIDGE_MESSAGE_SOURCE = "__JUMPSCARE_NETFLIX_BRIDGE__";
  const BRIDGE_SCRIPT_ID = "jumpscare-netflix-player-bridge";
  const WARNING_OVERLAY_ID = "jumpscare-warning-overlay";
  const MUTE_BEFORE_SECONDS = 2;
  const MUTE_AFTER_SECONDS = 2;
  const SEEK_BACK_RESET_THRESHOLD = 8;
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
  let mutedScares = new Set<number>();
  let lastAutomationTime: number | null = null;
  let warningOverlay: HTMLDivElement | null = null;
  let warningOverlayValue: HTMLSpanElement | null = null;
  let scanScheduled = false;

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
          actualJumpscareData[matchedTitle as keyof typeof actualJumpscareData]
        )
      : [];
  }

  function normalizeSettings(
    rawSettings: Partial<ExtensionSettings> | null | undefined
  ): ExtensionSettings {
    return {
      enabled:
        typeof rawSettings?.enabled === "boolean"
          ? rawSettings.enabled
          : DEFAULT_SETTINGS.enabled,
      warn: Boolean(rawSettings?.warn),
      mute: Boolean(rawSettings?.mute),
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
        !("enabled" in changes) &&
        !("warn" in changes) &&
        !("mute" in changes) &&
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
    try {
      chrome.runtime.sendMessage(message, () => {
        void chrome.runtime.lastError;
      });
    } catch {
      // The page can keep a stale content script alive after the extension reloads.
    }
  }

  function isManagedOverlayNode(node: Node): boolean {
    return (
      node instanceof HTMLElement &&
      (node.id === WARNING_OVERLAY_ID ||
        node.id === BRIDGE_SCRIPT_ID ||
        node.closest?.(`#${WARNING_OVERLAY_ID}`) instanceof HTMLElement)
    );
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
    const match = value.trim().match(/^-?(\d+):(\d{2})(?::(\d{2}))?$/);
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
    if (trackedVideo && Number.isFinite(trackedVideo.currentTime)) {
      return trackedVideo.currentTime;
    }

    if (hasFreshBridgeTime()) {
      return bridgeTimeSeconds;
    }

    return getVisiblePlayerTime();
  }

  function getTimeUntilNextScare(currentTime: number | null): number | null {
    if (typeof currentTime !== "number" || !Number.isFinite(currentTime)) {
      return null;
    }

    const nextScare = jumpscareTimes.find(scareTime => scareTime > currentTime);
    return nextScare != null ? nextScare - currentTime : null;
  }

  function getSecondsToNextScare(currentTime: number | null): number | null {
    const timeUntilNextScare = getTimeUntilNextScare(currentTime);
    return timeUntilNextScare != null ? Math.ceil(timeUntilNextScare) : null;
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

  function getWarningOverlayHost(): HTMLElement {
    if (document.fullscreenElement instanceof HTMLElement) {
      return document.fullscreenElement;
    }

    return (document.body || document.documentElement) as HTMLElement;
  }

  function ensureWarningOverlay(): HTMLDivElement {
    const host = getWarningOverlayHost();
    const existingOverlay =
      warningOverlay?.isConnected
        ? warningOverlay
        : document.getElementById(WARNING_OVERLAY_ID);
    const existingValue =
      warningOverlayValue?.isConnected
        ? warningOverlayValue
        : existingOverlay?.querySelector("[data-jumpscare-countdown-value]");

    if (
      existingOverlay instanceof HTMLDivElement &&
      existingValue instanceof HTMLSpanElement
    ) {
      if (existingOverlay.parentElement !== host) {
        host.appendChild(existingOverlay);
      }
      warningOverlay = existingOverlay;
      warningOverlayValue = existingValue;
      return existingOverlay;
    }

    const overlay = document.createElement("div");
    overlay.id = WARNING_OVERLAY_ID;
    Object.assign(overlay.style, {
      position: "fixed",
      top: "24px",
      right: "24px",
      transform: "translateY(-12px)",
      display: "flex",
      flexDirection: "column",
      alignItems: "flex-start",
      gap: "4px",
      minWidth: "148px",
      padding: "12px 16px",
      borderRadius: "16px",
      border: "1px solid rgba(220, 47, 47, 0.72)",
      background:
        "linear-gradient(160deg, rgba(24, 24, 24, 0.96), rgba(10, 10, 10, 0.92))",
      boxShadow: "0 14px 32px rgba(0, 0, 0, 0.4)",
      backdropFilter: "blur(8px)",
      color: "#ffffff",
      fontFamily: "system-ui, sans-serif",
      pointerEvents: "none",
      zIndex: "2147483647",
      opacity: "0",
      transition: "opacity 160ms ease, transform 160ms ease"
    });

    const label = document.createElement("span");
    label.textContent = "JUMP SCARE";
    Object.assign(label.style, {
      fontSize: "10px",
      fontWeight: "700",
      letterSpacing: "0.22em",
      textTransform: "uppercase",
      color: "rgba(255, 255, 255, 0.72)"
    });

    const value = document.createElement("span");
    value.dataset.jumpscareCountdownValue = "true";
    value.textContent = "0s";
    Object.assign(value.style, {
      fontSize: "32px",
      fontWeight: "800",
      lineHeight: "1",
      color: "#ff7575",
      textShadow: "0 0 18px rgba(220, 47, 47, 0.28)"
    });

    overlay.append(label, value);
    host.appendChild(overlay);

    warningOverlay = overlay;
    warningOverlayValue = value;
    return overlay;
  }

  function removeWarningOverlay(): void {
    warningOverlay?.remove();
    warningOverlay = null;
    warningOverlayValue = null;
  }

  function updateWarningOverlay(currentTime: number | null): void {
    if (!settings.warn) {
      removeWarningOverlay();
      return;
    }

    const timeUntilNextScare = getTimeUntilNextScare(currentTime);

    if (
      !settings.enabled ||
      timeUntilNextScare === null ||
      timeUntilNextScare > settings.timer
    ) {
      removeWarningOverlay();
      return;
    }

    const overlay = ensureWarningOverlay();
    if (!warningOverlayValue) {
      return;
    }

    const nextOverlayText = `${Math.ceil(timeUntilNextScare)}s`;
    if (warningOverlayValue.textContent !== nextOverlayText) {
      warningOverlayValue.textContent = nextOverlayText;
    }
    overlay.style.opacity = "1";
    overlay.style.transform = "translateY(0)";
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
    mutedScares = new Set();
    lastAutomationTime = null;
    removeWarningOverlay();
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
    mutedScares = new Set(
      [...mutedScares].filter(
        scareTime => scareTime < currentTime - MUTE_BEFORE_SECONDS
      )
    );
    clearAutoMute();
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
    updateWarningOverlay(currentTime);

    if (!settings.enabled) {
      clearAutoMute();
      return;
    }

    if (typeof currentTime !== "number" || !Number.isFinite(currentTime)) {
      if (!settings.mute) {
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

    if (jumpscareTimes.length === 0) {
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

    if (trackedVideo?.paused) {
      return;
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
      const shouldPublishState = force || lastPublishedSecond !== -1;
      if (shouldPublishState) {
        lastPublishedSecond = -1;
      }
      evaluateAutomation(nextTime);
      if (shouldPublishState) {
        publishState();
      }
      return;
    }

    const nextSecond = Math.floor(nextTime);
    if (!force && nextSecond === lastPublishedSecond) {
      evaluateAutomation(nextTime);
      return;
    }

    lastPublishedSecond = nextSecond;
    evaluateAutomation(nextTime);
    sendRuntimeMessage({
      action: "timeUpdate",
      currentTime: nextTime
    });
    publishState();
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

  function scheduleScan(force = false): void {
    if (force) {
      scanScheduled = false;
      scanPage(true);
      return;
    }

    if (scanScheduled) {
      return;
    }

    scanScheduled = true;
    window.requestAnimationFrame(() => {
      scanScheduled = false;
      scanPage();
    });
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

  const observer = new MutationObserver(records => {
    const onlyManagedNodesChanged = records.every(record =>
      [...record.addedNodes, ...record.removedNodes].every(isManagedOverlayNode)
    );

    if (onlyManagedNodesChanged) {
      return;
    }

    scheduleScan();
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

    if (!settings.enabled) {
      resetAutomationState();
    } else if (!settings.mute) {
      clearAutoMute();
    }

    evaluateAutomation(getCurrentTime());
  });

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        startObserver();
        scheduleScan(true);
      },
      { once: true }
    );
  } else {
    startObserver();
    scheduleScan(true);
  }

  window.addEventListener("popstate", () => {
    handleLocationChange(true);
  });

  window.addEventListener("unload", () => {
    clearAutoMute();
    removeWarningOverlay();
    unsubscribeFromSettings();
  });

  window.setInterval(() => {
    scheduleScan();
  }, 1000);
}
