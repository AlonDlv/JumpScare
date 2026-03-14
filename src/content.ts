/// <reference types="chrome" />

type WindowWithJumpscareFlags = Window & {
  __jumpscareContentScriptInstalled?: boolean;
};

type PlaybackState = {
  title: string | null;
  currentTime: number | null;
  hasVideo: boolean;
  url: string;
};

const windowWithFlags = window as WindowWithJumpscareFlags;

if (!windowWithFlags.__jumpscareContentScriptInstalled) {
  windowWithFlags.__jumpscareContentScriptInstalled = true;

  console.log("[JumpsCare] content script loaded");

  const BRIDGE_MESSAGE_SOURCE = "__JUMPSCARE_NETFLIX_BRIDGE__";
  const BRIDGE_SCRIPT_ID = "jumpscare-netflix-player-bridge";
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

  let currentTitle: string | null = null;
  let trackedVideo: HTMLVideoElement | null = null;
  let lastPublishedSecond = -1;
  let lastKnownUrl = location.href;
  let bridgeTimeSeconds: number | null = null;
  let bridgeTimeUpdatedAt = 0;
  let bridgeInjected = false;

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

  function createPlaybackState(): PlaybackState {
    return {
      title: currentTitle,
      currentTime: getCurrentTime(),
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
      return;
    }

    const nextSecond = Math.floor(nextTime);
    if (!force && nextSecond === lastPublishedSecond) {
      return;
    }

    lastPublishedSecond = nextSecond;
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
    bridgeTimeSeconds = null;
    bridgeTimeUpdatedAt = 0;

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
      sendResponse: (response?: PlaybackState | { title: string | null }) => void
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

  window.setInterval(() => {
    scanPage();
  }, 1000);
}
