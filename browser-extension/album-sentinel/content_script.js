// Attempts to read the Instagram username from the DOM.
// Responds to messages from the popup asking for the username.

function extractUsernameFromDom() {
  // Use og:description which usually contains "... (@username) • Instagram photos..."
  const ogDesc = document.querySelector('meta[property="og:description"]')?.content;
  const matchDesc = ogDesc?.match(/\(@([^)]+)\)/);
  if (matchDesc?.[1]) {
    return matchDesc[1].trim();
  }

  // Fallback to og:title which often looks like "username (@username) • Instagram photos..."
  const ogTitle = document.querySelector('meta[property="og:title"]')?.content;
  const matchTitle = ogTitle?.match(/\(@([^)]+)\)/);
  if (matchTitle?.[1]) {
    return matchTitle[1].trim();
  }

  // Last resort: try the visible handle element.
  const headingHandle = document.querySelector('header h2, main h2');
  if (headingHandle?.textContent) {
    const text = headingHandle.textContent.trim();
    if (text && !text.includes(' ')) {
      return text;
    }
  }

  return null;
}

document.addEventListener("contextmenu", (event) => {
  const image = event.target?.closest?.("img");
  if (!image) {
    return;
  }

  const url = image.currentSrc || image.src || "";
  if (!url) {
    return;
  }

  const payload = {
    url,
    pageUrl: window.location.href,
    createdAt: Date.now()
  };

  const storeCurrentImage = (extra = {}) => {
    chrome.runtime.sendMessage({
      type: "RIGHT_CLICKED_IMAGE",
      image: { ...payload, ...extra }
    });
  };

  storeCurrentImage();

  if (url.startsWith("blob:") || url.startsWith("data:")) {
    fetch(url)
      .then((response) => response.blob())
      .then(blobToDataUrl)
      .then((dataUrl) => storeCurrentImage({ dataUrl }))
      .catch(() => {});
  }
}, true);

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_INSTAGRAM_USERNAME") {
    sendResponse({ username: extractUsernameFromDom() });
  }
  // Returning false keeps this synchronous.
  return false;
});
