chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "fetchJumpscares" && message.title) {
    fetch(`https://cybki9m36c.execute-api.eu-north-1.amazonaws.com/prod/movies?title=${encodeURIComponent(message.title)}`, {
      headers: {
        "x-api-key": "nhNLUyx6IL9hIOWg2GrtE3MqnuKNhsqjMuqpK8qh"
      }
    })
      .then(res => {
        if (!res.ok) return null;
        return res.json();
      })
      .then(data => sendResponse({ data }))
      .catch(err => {
        console.error("Background fetch error:", err);
        sendResponse({ data: null });
      });

    return true; // Keep message channel open for async response
  }
});