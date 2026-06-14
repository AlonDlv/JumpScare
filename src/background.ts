chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "fetchJumpscares" && message.title) {
    fetch(`https://cybki9m36c.execute-api.eu-north-1.amazonaws.com/prod/v2?title=${encodeURIComponent(message.title)}`, {
      headers: {
        "x-api-key": "nhNLUyx6IL9hIOWg2GrtE3MqnuKNhsqjMuqpK8qh"
      }
    })
      .then(res => {
        if (!res.ok) return null;
        return res.json();
      })
      .then(data => {
        if (data && data.movies && data.movies.length > 0) {
          sendResponse({ data: data.movies[0] });
        } else {
          sendResponse({ data: null });
        }
      })
      .catch(err => {
        console.error("Background fetch error:", err);
        sendResponse({ data: null });
      });

    return true; // Keep message channel open for async response
  }
});