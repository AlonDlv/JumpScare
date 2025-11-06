/// <reference types="chrome" />
console.log("[JumpsCare] content script loaded");

function getNetflixTitle(): string | null {
  const selectors = [
    "[data-uia='video-title']",
    "[data-uia='player-title']",
    ".video-title",
    "h1"
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el?.textContent) {
      return el.textContent.trim();
    }
  }
  // fallback from document.title
  return document.title.split("|")[0].trim() || null;
}

chrome.runtime.onMessage.addListener(
  (msg: { action: string }, sender, sendResponse) => {
    if (msg.action === "getTitle") {
      sendResponse({ title: getNetflixTitle() });
    }
  }
);

function hookVideo(): void {
  const video = document.querySelector("video");
  if (!video) return;
  video.addEventListener("timeupdate", () => {
    chrome.runtime.sendMessage({
      action: "timeUpdate",
      currentTime: video.currentTime
    });
  });
}

// wait for <video> element to appear
const observer = new MutationObserver((_, obs) => {
  if (document.querySelector("video")) {
    console.log("[JumpsCare] video found — hooking timeupdate");
    hookVideo();
    obs.disconnect();
  }
});
observer.observe(document.body, { childList: true, subtree: true });
