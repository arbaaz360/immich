async function blobToPng(blob) {
  if (blob.type === "image/png") {
    return blob;
  }

  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Could not create clipboard canvas.");
    }

    context.drawImage(bitmap, 0, 0);
    return await canvas.convertToBlob({ type: "image/png" });
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

async function copyImageToClipboard({ imageUrl, dataUrl }) {
  if (!navigator.clipboard?.write || !self.ClipboardItem) {
    throw new Error("Extension image clipboard support is unavailable.");
  }

  const sourceBlob = dataUrl ? await dataUrlToBlob(dataUrl) : await fetchImageBlob(imageUrl);
  const pngBlob = await blobToPng(sourceBlob);
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": pngBlob })
  ]);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "OFFSCREEN_COPY_IMAGE") {
    return false;
  }

  copyImageToClipboard(message)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));

  return true;
});
