// public/content.js
console.log("[JumpsCare] content script loaded");

function getNetflixTitle() {
  const el = document.querySelector("[data-uia='video-title']")
          || document.querySelector("h1");
  return el?.textContent.trim()
      || document.title.split("|")[0].trim()
      || null;
}

chrome.runtime.onMessage.addListener((msg, _, sendResponse) => {
  if (msg.action === "getTitle") {
    sendResponse({ title: getNetflixTitle() });
  }
});

new MutationObserver((_, obs) => {
  const video = document.querySelector("video");
  if (!video) return;
  console.log("[JumpsCare] video found — hooking timeupdate");
  video.addEventListener("timeupdate", () => {
    chrome.runtime.sendMessage({
      action: "timeUpdate",
      currentTime: video.currentTime
    });
  });
  obs.disconnect();
}).observe(document.body, { childList: true, subtree: true });
