const REVERSE_FACE_SEARCH_URL = "http://localhost:2299/";
const IMAGE_REQUEST_PREFIX = "albumSentinelImageRequest:";

const statusEl = document.getElementById("status");

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.className = isError ? "error" : "";
}

function dataUrlToBlob(dataUrl) {
  const [header, base64] = dataUrl.split(",", 2);
  const mimeMatch = header.match(/^data:([^;]+);base64$/);
  const mimeType = mimeMatch?.[1] || "application/octet-stream";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: mimeType });
}

function filenameFromUrl(imageUrl, blob) {
  try {
    const parsedUrl = new URL(imageUrl);
    const lastPart = parsedUrl.pathname.split("/").filter(Boolean).pop();
    if (lastPart) {
      return lastPart;
    }
  } catch (_error) {
    // Fall through to MIME-based name.
  }

  const extension = blob.type === "image/png" ? "png" : "jpg";
  return `immich-query.${extension}`;
}

function withReverseSearchBaseUrl(html) {
  const baseTag = `<base href="${REVERSE_FACE_SEARCH_URL}">`;
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
  }

  return `${baseTag}${html}`;
}

async function getRequest() {
  const params = new URLSearchParams(window.location.search);
  const requestId = params.get("id");
  if (!requestId) {
    throw new Error("Missing image request id.");
  }

  const key = `${IMAGE_REQUEST_PREFIX}${requestId}`;
  const stored = await chrome.storage.local.get(key);
  await chrome.storage.local.remove(key);

  if (!stored[key]) {
    throw new Error("The selected image was not found. Reload the extension and try again.");
  }

  return stored[key];
}

async function getImageBlob(request) {
  if (request.dataUrl) {
    return dataUrlToBlob(request.dataUrl);
  }

  if (!request.imageUrl) {
    throw new Error("The selected image did not provide an image URL.");
  }

  setStatus("Downloading the selected image...");
  const response = await fetch(request.imageUrl, {
    credentials: "include",
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Could not download image: HTTP ${response.status}.`);
  }

  return response.blob();
}

async function runSearch() {
  const request = await getRequest();
  const blob = await getImageBlob(request);

  setStatus("Submitting the image to reverse face search...");
  const formData = new FormData();
  formData.append("image", blob, filenameFromUrl(request.imageUrl, blob));
  formData.append("scope", "instagram");
  formData.append("limit", "20");
  formData.append("threshold", "0.6");

  const response = await fetch(REVERSE_FACE_SEARCH_URL, {
    method: "POST",
    body: formData
  });

  if (!response.ok) {
    throw new Error(`Reverse face search returned HTTP ${response.status}.`);
  }

  const html = withReverseSearchBaseUrl(await response.text());
  document.open();
  document.write(html);
  document.close();
}

runSearch().catch((error) => {
  setStatus(error.message, true);
});
