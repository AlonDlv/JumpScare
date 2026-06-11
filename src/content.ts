/// <reference types="chrome" />
type WindowWithJumpscareFlags = Window & {
  __jumpscareContentScriptInstalled?: boolean;
};

type ExtensionSettings = {
  enabled: boolean;
  warn: boolean;
  mute: boolean;
  blur: boolean;
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
    blur: false,
    timer: 3
  };
  const BRIDGE_MESSAGE_SOURCE = "__JUMPSCARE_NETFLIX_BRIDGE__";
  const BRIDGE_SCRIPT_ID = "jumpscare-netflix-player-bridge";
  const WARNING_OVERLAY_ID = "jumpscare-warning-overlay";
  const BLUR_OVERLAY_ID = "jumpscare-blur-overlay";
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
  let activeBlur: { scareTime: number } | null = null;
  let triggeredScares = new Set<number>();
  let lastAutomationTime: number | null = null;
  let warningOverlay: HTMLDivElement | null = null;
  let warningOverlayValue: HTMLSpanElement | null = null;
  let scanScheduled = false;

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

  function fetchJumpscareData(movieTitle: string): Promise<JumpscareEntry | null> {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(
          { action: "fetchJumpscares", title: movieTitle },
          (response) => {
            if (chrome.runtime.lastError || !response) {
              resolve(null);
            } else {
              resolve(response.data || null);
            }
          }
        );
      } catch (err) {
        resolve(null);
      }
    });
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
      blur: Boolean(rawSettings?.blur),
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
        !("blur" in changes) &&
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
        node.id === BLUR_OVERLAY_ID ||
        node.id === BRIDGE_SCRIPT_ID ||
        node.closest?.(`#${WARNING_OVERLAY_ID}`) instanceof HTMLElement ||
        node.closest?.(`#${BLUR_OVERLAY_ID}`) instanceof HTMLElement)
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

    if (!document.getElementById("jumpscare-warning-styles")) {
      const style = document.createElement("style");
      style.id = "jumpscare-warning-styles";
      style.textContent = `
        @keyframes jumpscareHeartbeat {
          0%, 100% {
            border-color: rgba(220, 47, 47, 0.2);
            box-shadow: 0 14px 32px rgba(0, 0, 0, 0.4), 0 0 0 rgba(220, 47, 47, 0);
          }
          50% {
            border-color: rgba(220, 47, 47, 0.9);
            box-shadow: 0 14px 32px rgba(0, 0, 0, 0.4), 0 0 24px rgba(220, 47, 47, 0.6);
          }
        }
        @keyframes jumpscareTextPulse {
          0%, 100% {
            text-shadow: 0 0 4px rgba(220, 47, 47, 0.1);
          }
          50% {
            text-shadow: 0 0 16px rgba(220, 47, 47, 0.9);
          }
        }
      `;
      document.head.appendChild(style);
    }

    const overlay = document.createElement("div");
    overlay.id = WARNING_OVERLAY_ID;
    Object.assign(overlay.style, {
      position: "fixed",
      top: "24px",
      right: "24px",
      transform: "translateY(-12px)",
      display: "flex",
      flexDirection: "row",
      alignItems: "center",
      gap: "10px",
      padding: "8px 20px 8px 14px",
      borderRadius: "9999px",
      border: "1px solid rgba(220, 47, 47, 0.4)",
      background:
        "linear-gradient(160deg, rgba(32, 32, 32, 0.96), rgba(16, 16, 16, 0.92))",
      boxShadow: "0 14px 32px rgba(0, 0, 0, 0.4)",
      backdropFilter: "blur(8px)",
      color: "#ffffff",
      fontFamily: "system-ui, -apple-system, sans-serif",
      pointerEvents: "none",
      zIndex: "2147483647",
      opacity: "0",
      transition: "opacity 160ms ease, transform 160ms ease",
      animation: "jumpscareHeartbeat var(--jumpscare-pulse-duration, 1s) infinite"
    });

    const icon = document.createElement("div");
    icon.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2.5L1 21.5h22L12 2.5z" fill="#dc2f2f" stroke="#dc2f2f" stroke-width="1" stroke-linejoin="round"/>
      <path d="M11 10h2v5h-2v-5zm0 7h2v2h-2v-2z" fill="#fff"/>
    </svg>`;
    Object.assign(icon.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "center"
    });

    const label = document.createElement("span");
    label.textContent = "JUMPSCARE IN";
    Object.assign(label.style, {
      fontSize: "14px",
      fontWeight: "600",
      letterSpacing: "0.06em",
      color: "rgba(255, 255, 255, 0.9)",
      whiteSpace: "nowrap"
    });

    const value = document.createElement("span");
    value.dataset.jumpscareCountdownValue = "true";
    value.textContent = "0s";
    Object.assign(value.style, {
      fontSize: "22px",
      fontWeight: "700",
      color: "#ffffff",
      fontVariantNumeric: "tabular-nums",
      animation: "jumpscareTextPulse var(--jumpscare-pulse-duration, 1s) infinite"
    });

    overlay.append(icon, label, value);
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

    const pulseSpeed = Math.max(0.25, timeUntilNextScare / 10);
    overlay.style.setProperty("--jumpscare-pulse-duration", `${pulseSpeed}s`);

    overlay.style.opacity = "1";
    overlay.style.transform = "translateY(0)";
  }

  function ensureBlurOverlay(): void {
    const host = getWarningOverlayHost();
    const existingOverlay = document.getElementById(BLUR_OVERLAY_ID);
    
    if (existingOverlay instanceof HTMLDivElement) {
      if (existingOverlay.parentElement !== host) {
        host.appendChild(existingOverlay);
      }
      return;
    }

    const overlay = document.createElement("div");
    overlay.id = BLUR_OVERLAY_ID;
    Object.assign(overlay.style, {
      position: "fixed",
      top: "0",
      left: "0",
      width: "100vw",
      height: "100vh",
      backdropFilter: "blur(25px)",
      WebkitBackdropFilter: "blur(25px)",
      pointerEvents: "none",
      zIndex: "2147483646",
      transition: "backdrop-filter 0.1s ease"
    });

    host.appendChild(overlay);
  }

  function removeBlurOverlay(): void {
    const existingOverlay = document.getElementById(BLUR_OVERLAY_ID);
    if (existingOverlay) {
      existingOverlay.remove();
    }
  }

  function clearAutoBlur(): void {
    activeBlur = null;
    removeBlurOverlay();
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
    clearAutoBlur();
    triggeredScares = new Set();
    lastAutomationTime = null;
    removeWarningOverlay();
  }

  async function syncMatchedMovie(): Promise<void> {
    if (!currentTitle) {
      if (matchedMovieTitle !== null) {
        matchedMovieTitle = null;
        jumpscareTimes = [];
        resetAutomationState();
      }
      return;
    }

    if (currentTitle === matchedMovieTitle) {
      return;
    }

    const titleToFetch = currentTitle;
    const data = await fetchJumpscareData(titleToFetch);

    if (currentTitle !== titleToFetch) {
      return;
    }

    matchedMovieTitle = titleToFetch;
    jumpscareTimes = data ? parseJumpscareSeconds(data) : [];
    resetAutomationState();
  }

  function resetTriggeredScaresForSeek(currentTime: number): void {
    triggeredScares = new Set(
      [...triggeredScares].filter(
        scareTime => scareTime < currentTime - MUTE_BEFORE_SECONDS
      )
    );
    clearAutoMute();
    clearAutoBlur();
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

    trackedVideo.muted = true;
  }

  function triggerBlur(scareTime: number): void {
    if (activeBlur && activeBlur.scareTime === scareTime) {
      return;
    }

    clearAutoBlur();

    activeBlur = { scareTime };

    ensureBlurOverlay();
  }

  function evaluateAutomation(currentTime: number | null): void {
    updateWarningOverlay(currentTime);

    if (!settings.enabled) {
      clearAutoMute();
      clearAutoBlur();
      return;
    }

    if (typeof currentTime !== "number" || !Number.isFinite(currentTime)) {
      if (!settings.mute) {
        clearAutoMute();
      }
      if (!settings.blur) {
        clearAutoBlur();
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
      clearAutoBlur();
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

    if (activeBlur) {
      const inBlurWindow =
        currentTime >= activeBlur.scareTime - MUTE_BEFORE_SECONDS &&
        currentTime < activeBlur.scareTime + MUTE_AFTER_SECONDS;

      if (!settings.blur || !inBlurWindow) {
        clearAutoBlur();
      }
    }

    if (trackedVideo?.paused) {
      return;
    }

    if (settings.mute || settings.blur) {
      const scareToActOn = jumpscareTimes.find(
        scareTime =>
          !triggeredScares.has(scareTime) &&
          currentTime >= scareTime - MUTE_BEFORE_SECONDS &&
          currentTime < scareTime + MUTE_AFTER_SECONDS
      );

      if (scareToActOn !== undefined) {
        triggeredScares.add(scareToActOn);
        if (settings.mute) triggerMute(scareToActOn);
        if (settings.blur) triggerBlur(scareToActOn);
      }
    }
  }

  async function publishTitle(force = false): Promise<void> {
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
    await syncMatchedMovie();

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

  async function handleLocationChange(force = false): Promise<void> {
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
    await publishTitle(true);
    publishCurrentTime(true);
  }

  async function scanPage(force = false): Promise<void> {
    if (location.href !== lastKnownUrl) {
      await handleLocationChange(true);
      return;
    }

    attachToVideo();
    await publishTitle(force);
    publishCurrentTime(force);
    injectPlayerBridge();
  }

  function scheduleScan(force = false): void {
    if (force) {
      scanScheduled = false;
      void scanPage(true);
      return;
    }

    if (scanScheduled) {
      return;
    }

    scanScheduled = true;
    window.requestAnimationFrame(() => {
      scanScheduled = false;
      void scanPage();
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
        scanPage().then(() => {
          sendResponse(createPlaybackState());
        });
        return true;
      }

      if (message.action === "getTitle") {
        publishTitle().then(() => {
          sendResponse({ title: currentTitle });
        });
        return true;
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
    void handleLocationChange(true);
  });

  window.addEventListener("pagehide", () => {
    clearAutoMute();
    removeWarningOverlay();
    unsubscribeFromSettings();
  });

  window.setInterval(() => {
    scheduleScan();
  }, 1000);
}
