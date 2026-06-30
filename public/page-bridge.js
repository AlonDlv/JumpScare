(() => {
  const MESSAGE_SOURCE = "__JUMPSCARE_NETFLIX_BRIDGE__";

  if (window.__jumpscareNetflixBridgeInstalled) {
    return;
  }

  window.__jumpscareNetflixBridgeInstalled = true;

  function getNetflixPlayer() {
    try {
      const playerApp = window.netflix?.appContext?.state?.playerApp;
      const api = playerApp?.getAPI?.();
      const videoPlayer = api?.videoPlayer;
      const sessionIds = videoPlayer?.getAllPlayerSessionIds?.();

      if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
        return null;
      }

      const sessionId = sessionIds.find(Boolean) || sessionIds[0];
      return videoPlayer.getVideoPlayerBySessionId?.(sessionId) || null;
    } catch {
      return null;
    }
  }

  let lastSentMs = -1;

  function publishPlayerTime() {
    const player = getNetflixPlayer();
    if (!player) {
      return;
    }

    let currentTimeMs;
    try {
      currentTimeMs = player.getCurrentTime?.();
    } catch {
      return;
    }

    if (typeof currentTimeMs !== "number" || !Number.isFinite(currentTimeMs)) {
      return;
    }

    const wholeMs = Math.floor(currentTimeMs);
    if (wholeMs === lastSentMs) {
      return;
    }

    lastSentMs = wholeMs;
    window.postMessage(
      {
        source: MESSAGE_SOURCE,
        action: "playerTime",
        currentTimeMs
      },
      "*"
    );
  }

  publishPlayerTime();
  window.setInterval(publishPlayerTime, 500);

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.source !== MESSAGE_SOURCE) {
      return;
    }

    if (event.data.action === "seekPlayer" && typeof event.data.targetTimeMs === "number") {
      const player = getNetflixPlayer();
      if (player && typeof player.seek === "function") {
        try {
          player.seek(event.data.targetTimeMs);
        } catch (err) {
          console.error("[JumpsCare] Error seeking player:", err);
        }
      }
    }
  });
})();
