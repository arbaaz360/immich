const REVERSE_FACE_SEARCH_URL = "http://localhost:2299/";
const MENU_ID = "album-sentinel-reverse-face-search";
const IMAGE_REQUEST_PREFIX = "albumSentinelImageRequest:";
const LAST_IMAGE_PREFIX = "albumSentinelLastImage:";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Search this face in Immich",
    contexts: ["image"]
  });
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "RIGHT_CLICKED_IMAGE" || !sender.tab?.id || !message.image) {
    return false;
  }

  chrome.storage.local.set({
    [`${LAST_IMAGE_PREFIX}${sender.tab.id}`]: {
      ...message.image,
      capturedAt: Date.now()
    }
  });

  return false;
});

async function getStoredRightClickImage(tabId) {
  if (!tabId) {
    return null;
  }

  const key = `${LAST_IMAGE_PREFIX}${tabId}`;
  const stored = await chrome.storage.local.get(key);
  return stored[key] || null;
}

async function getStoredRightClickImageWithBlobWait(tabId) {
  const firstImage = await getStoredRightClickImage(tabId);
  if (!firstImage?.url?.startsWith("blob:") || firstImage.dataUrl) {
    return firstImage;
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const latestImage = await getStoredRightClickImage(tabId);
    if (latestImage?.dataUrl) {
      return latestImage;
    }
  }

  return firstImage;
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) {
    return;
  }

  const capturedImage = await getStoredRightClickImageWithBlobWait(tab?.id);
  const imageUrl = info.srcUrl || capturedImage?.url || "";
  const dataUrl = capturedImage?.dataUrl || "";

  if (!imageUrl && !dataUrl) {
    chrome.tabs.create({ url: REVERSE_FACE_SEARCH_URL });
    return;
  }

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await chrome.storage.local.set({
    [`${IMAGE_REQUEST_PREFIX}${requestId}`]: {
      imageUrl,
      dataUrl,
      pageUrl: tab?.url || "",
      createdAt: Date.now()
    }
  });

  chrome.tabs.create({
    url: chrome.runtime.getURL(`search.html?id=${encodeURIComponent(requestId)}`)
  });
});
