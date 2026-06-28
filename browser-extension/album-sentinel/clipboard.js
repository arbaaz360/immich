const CLIPBOARD_REQUEST_PREFIX = "albumSentinelClipboardRequest:";

function status(text) {
  const element = document.getElementById("status");
  if (element) {
    element.textContent = text;
  }
}

function requestIdFromUrl() {
  return new URLSearchParams(location.search).get("id") || "";
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

async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  return response.blob();
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

async function copyRequestToClipboard(request) {
  if (!navigator.clipboard?.write || !window.ClipboardItem) {
    throw new Error("Image clipboard write is unavailable in the extension popup.");
  }

  const sourceBlob = request.dataUrl ? await dataUrlToBlob(request.dataUrl) : await fetchImageBlob(request.imageUrl);
  const pngBlob = await blobToPng(sourceBlob);
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": pngBlob })
  ]);
}

async function notifyResult(requestId, ok, error = "") {
  await chrome.runtime.sendMessage({
    type: "CLIPBOARD_COPY_RESULT",
    requestId,
    ok,
    error
  });
}

async function main() {
  const requestId = requestIdFromUrl();
  if (!requestId) {
    throw new Error("Missing clipboard request id.");
  }

  const key = `${CLIPBOARD_REQUEST_PREFIX}${requestId}`;
  const stored = await chrome.storage.local.get(key);
  const request = stored[key];
  await chrome.storage.local.remove(key);
  if (!request) {
    throw new Error("Clipboard request was not found.");
  }

  status("Writing image to clipboard...");
  await copyRequestToClipboard(request);
  status("Copied.");
  await notifyResult(requestId, true);
  setTimeout(() => window.close(), 250);
}

main().catch(async (error) => {
  console.error(error);
  status(`Copy failed: ${String(error?.message || error)}`);
  await notifyResult(requestIdFromUrl(), false, String(error?.message || error));
});
