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

function dataUrlToBlob(dataUrl) {
  return fetch(dataUrl).then((response) => response.blob());
}

async function blobToPng(blob) {
  if (blob.type === "image/png") {
    return blob;
  }

  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Could not create clipboard canvas.");
    }

    context.drawImage(bitmap, 0, 0);
    return await new Promise((resolve, reject) => {
      canvas.toBlob((pngBlob) => {
        if (pngBlob) {
          resolve(pngBlob);
        } else {
          reject(new Error("Could not convert image for clipboard."));
        }
      }, "image/png");
    });
  } finally {
    bitmap.close?.();
  }
}

async function fetchImageBlob(imageUrl) {
  const response = await fetch(imageUrl, {
    credentials: "include",
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Could not fetch image: HTTP ${response.status}`);
  }

  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) {
    throw new Error(`Fetched resource is not an image: ${blob.type || "unknown type"}`);
  }

  return blob;
}

function immichPhotoAssetId() {
  return window.location.pathname.match(/\/photos\/([0-9a-fA-F-]{36})$/)?.[1] || "";
}

function largestVisibleImmichImage(assetId) {
  const candidates = Array.from(document.images || [])
    .filter((image) => {
      const src = image.currentSrc || image.src || "";
      if (!src) {
        return false;
      }

      return src.includes(assetId) || src.includes("/api/assets/");
    })
    .map((image) => {
      const rect = image.getBoundingClientRect();
      return {
        image,
        area: Math.max(0, rect.width) * Math.max(0, rect.height)
      };
    })
    .filter(({ area }) => area > 10000)
    .sort((a, b) => b.area - a.area);

  return candidates[0]?.image || null;
}

function absoluteUrl(url) {
  return new URL(url, window.location.origin).href;
}

async function imagePayloadForImmichPhoto() {
  const assetId = immichPhotoAssetId();
  if (!assetId) {
    throw new Error("This is not an Immich photo page.");
  }

  const displayedImage = largestVisibleImmichImage(assetId);
  const displayedUrl = displayedImage ? (displayedImage.currentSrc || displayedImage.src || "") : "";
  const originalUrl = absoluteUrl(`/api/assets/${assetId}/original`);

  if (displayedUrl?.startsWith("blob:") || displayedUrl?.startsWith("data:")) {
    const response = await fetch(displayedUrl);
    return {
      imageUrl: originalUrl,
      dataUrl: await blobToDataUrl(await response.blob())
    };
  }

  try {
    const response = await fetch(originalUrl, {
      credentials: "include",
      cache: "no-store"
    });
    if (response.ok) {
      return {
        imageUrl: originalUrl,
        dataUrl: await blobToDataUrl(await response.blob())
      };
    }
  } catch {
    // Fall back to extension-side fetch below.
  }

  return {
    imageUrl: originalUrl || absoluteUrl(displayedUrl)
  };
}

function setImmichCopyStatus(button, text, timeout = 0) {
  button.textContent = text;
  if (timeout) {
    window.setTimeout(() => {
      if (immichPhotoAssetId()) {
        button.textContent = "Copy image";
      }
    }, timeout);
  }
}

async function copyImmichImageWithExtension(button) {
  if (navigator.clipboard?.write && window.ClipboardItem) {
    return navigator.clipboard.write([
      new ClipboardItem({
        "image/png": (async () => {
          const payload = await imagePayloadForImmichPhoto();
          const sourceBlob = payload.dataUrl ? await dataUrlToBlob(payload.dataUrl) : await fetchImageBlob(payload.imageUrl);
          return blobToPng(sourceBlob);
        })()
      })
    ]);
  }

  const payload = await imagePayloadForImmichPhoto();
  const response = await chrome.runtime.sendMessage({
    type: "COPY_IMAGE_TO_CLIPBOARD",
    ...payload
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Image copy failed.");
  }
}

function enhanceImmichCopyButton() {
  const assetId = immichPhotoAssetId();
  const button = document.getElementById("immich-copy-original-image-button");
  if (!assetId || !button || button.dataset.albumSentinelCopyBound === "true") {
    return;
  }

  button.dataset.albumSentinelCopyBound = "true";
  button.textContent = "Copy image";
  button.title = "Copy this image using Album Sentinel";
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    button.disabled = true;
    setImmichCopyStatus(button, "Copying...");
    try {
      await copyImmichImageWithExtension(button);
      setImmichCopyStatus(button, "Copied", 1400);
    } catch (error) {
      console.error(error);
      setImmichCopyStatus(button, "Copy failed", 2500);
    } finally {
      button.disabled = false;
    }
  }, true);
}

function scheduleImmichEnhancement() {
  window.setTimeout(enhanceImmichCopyButton, 100);
}

const immichObserver = new MutationObserver(scheduleImmichEnhancement);
immichObserver.observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener("popstate", scheduleImmichEnhancement);
scheduleImmichEnhancement();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_INSTAGRAM_USERNAME") {
    sendResponse({ username: extractUsernameFromDom() });
  }
  // Returning false keeps this synchronous.
  return false;
});
