const REVERSE_FACE_SEARCH_URL = "http://localhost:2299/";
const MENU_ID = "album-sentinel-reverse-face-search";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Search this face in Immich",
    contexts: ["image"]
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== MENU_ID || !info.srcUrl) {
    return;
  }

  const targetUrl = `${REVERSE_FACE_SEARCH_URL}?imageUrl=${encodeURIComponent(info.srcUrl)}`;
  chrome.tabs.create({ url: targetUrl });
});
