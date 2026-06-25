const KEYS = {
  baseUrl: "immichBaseUrl",
  apiKey: "immichApiKey"
};

const DEFAULT_PRESETS = [
  { label: "arbaaz", apiKey: "" },
  { label: "realfire2023", apiKey: "" },
  { label: "firereal06", apiKey: "" }
];

const PRESETS =
  Array.isArray(window.ALBUM_SENTINEL_PRESETS) && window.ALBUM_SENTINEL_PRESETS.length
    ? window.ALBUM_SENTINEL_PRESETS
    : DEFAULT_PRESETS;

const usernameInput = document.getElementById("username");
const baseUrlInput = document.getElementById("baseUrl");
const apiKeyInput = document.getElementById("apiKey");
const presetSelect = document.getElementById("preset");
const detectedUserEl = document.getElementById("detectedUser");
const statusEl = document.getElementById("status");
const detailsEl = document.getElementById("details");
const saveBtn = document.getElementById("saveBtn");
const checkBtn = document.getElementById("checkBtn");
const checkAllBtn = document.getElementById("checkAllBtn");

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  populatePresets();
  await detectUsernameFromTab();
});

saveBtn.addEventListener("click", async () => {
  await saveSettings();
  showStatus("Settings saved locally.", "success");
});

checkBtn.addEventListener("click", async () => {
  await handleCheck();
});

checkAllBtn.addEventListener("click", async () => {
  await handleCheckAll();
});

presetSelect.addEventListener("change", () => {
  const chosen = PRESETS.find((p) => p.label === presetSelect.value);
  if (chosen) {
    apiKeyInput.value = chosen.apiKey;
  }
});

async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get([KEYS.baseUrl, KEYS.apiKey], (result) => {
      baseUrlInput.value = result[KEYS.baseUrl] || "http://localhost:2283";
      apiKeyInput.value = result[KEYS.apiKey] || "";
      resolve();
    });
  });
}

async function saveSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.set(
      {
        [KEYS.baseUrl]: baseUrlInput.value.trim(),
        [KEYS.apiKey]: apiKeyInput.value.trim()
      },
      () => resolve()
    );
  });
}

async function detectUsernameFromTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !tab.url) {
    detectedUserEl.textContent = "not available";
    return;
  }

  const usernameFromDom = await getUsernameFromContentScript(tab.id);
  const username = usernameFromDom || parseInstagramUsername(tab.url);

  if (username) {
    detectedUserEl.textContent = username;
    if (!usernameInput.value) {
      usernameInput.value = username;
    }
  } else {
    detectedUserEl.textContent = "not found on this page";
  }
}

function getUsernameFromContentScript(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: "GET_INSTAGRAM_USERNAME" }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response?.username || null);
      });
    } catch (_err) {
      resolve(null);
    }
  });
}

function parseInstagramUsername(urlString) {
  try {
    const url = new URL(urlString);
    if (!url.hostname.includes("instagram.com")) {
      return null;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 0) {
      return null;
    }
    const ignore = new Set([
      "p",
      "reel",
      "reels",
      "explore",
      "direct",
      "stories",
      "accounts",
      "challenge"
    ]);
    if (ignore.has(parts[0].toLowerCase())) {
      return null;
    }
    return parts[0];
  } catch (_err) {
    return null;
  }
}

async function handleCheck() {
  const username = usernameInput.value.trim();
  const baseUrl = baseUrlInput.value.trim().replace(/\/$/, "");
  const apiKey = apiKeyInput.value.trim();

  if (!username) {
    showStatus("Enter a username to check.", "error");
    return;
  }
  if (!baseUrl || !apiKey) {
    showStatus("Immich base URL and API key are required.", "error");
    return;
  }

  checkBtn.disabled = true;
  checkAllBtn.disabled = true;
  showStatus("Checking albums via Immich API…");

  await saveSettings();

  try {
    const endpoints = [
      { label: "owned", url: `${baseUrl}/api/albums` },
      { label: "shared", url: `${baseUrl}/api/albums?shared=true` }
    ];

    let found = null;

    for (const endpoint of endpoints) {
      const res = await fetch(endpoint.url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "x-api-key": apiKey
        }
      });

      if (res.status === 401 || res.status === 403) {
        showStatus("Auth failed. Confirm the Immich API key.", "error");
        return;
      }
      if (!res.ok) {
        showStatus(`Immich responded with ${res.status} on ${endpoint.label} albums.`, "error");
        return;
      }

      const albums = await res.json();
      const match = Array.isArray(albums)
        ? albums.find((album) => album?.albumName?.toLowerCase() === username.toLowerCase())
        : null;

      if (match) {
        found = { match, source: endpoint.label };
        break;
      }
    }

    if (found) {
      const album = found.match;
      const count = album.assetCount ?? album.assets?.length ?? "unknown";
      const lastUpdated =
        album.lastModifiedAssetTimestamp || album.updatedAt || album.createdAt || "unknown";
      const owner = album.owner?.email || album.owner?.name || "unknown";
      showStatus(`✅ Album "${username}" exists (${found.source}, ${count} items).`, "success");
      detailsEl.textContent = `Owner: ${owner} | Last updated: ${lastUpdated}`;
    } else {
      showStatus(`❌ Album "${username}" not found in owned/shared albums.`, "error");
      detailsEl.textContent = "";
    }
  } catch (err) {
    showStatus(`Request failed: ${err.message}`, "error");
    detailsEl.textContent = "";
  } finally {
    checkBtn.disabled = false;
    checkAllBtn.disabled = false;
  }
}

async function handleCheckAll() {
  const username = usernameInput.value.trim();
  const baseUrl = baseUrlInput.value.trim().replace(/\/$/, "");
  const presets = PRESETS.filter((preset) => preset.apiKey);

  if (!username) {
    showStatus("Enter a username to check.", "error");
    return;
  }
  if (!baseUrl) {
    showStatus("Immich base URL is required.", "error");
    return;
  }
  if (!presets.length) {
    showStatus("No local API key presets are configured.", "error");
    return;
  }

  checkBtn.disabled = true;
  checkAllBtn.disabled = true;
  showStatus(`Checking ${presets.length} accounts via Immich API...`);
  detailsEl.textContent = "";

  try {
    const matches = [];
    const failures = [];

    for (const preset of presets) {
      try {
        const found = await findAlbum(username, baseUrl, preset.apiKey);
        if (found) {
          matches.push({ preset, ...found });
        }
      } catch (err) {
        failures.push(`${preset.label}: ${err.message}`);
      }
    }

    if (matches.length) {
      showStatus(`Album "${username}" exists in ${matches.length} account(s).`, "success");
      detailsEl.textContent = matches
        .map(({ preset, match, source }) => {
          const count = match.assetCount ?? match.assets?.length ?? "unknown";
          const owner = match.owner?.email || match.owner?.name || preset.label;
          return `${preset.label}: ${source}, ${count} items, owner ${owner}`;
        })
        .join("\n");
    } else {
      showStatus(`Album "${username}" was not found in configured accounts.`, "error");
      detailsEl.textContent = failures.length ? `Failures: ${failures.join(" | ")}` : "";
    }
  } finally {
    checkBtn.disabled = false;
    checkAllBtn.disabled = false;
  }
}

async function findAlbum(username, baseUrl, apiKey) {
  const endpoints = [
    { label: "owned", url: `${baseUrl}/api/albums` },
    { label: "shared", url: `${baseUrl}/api/albums?shared=true` }
  ];

  for (const endpoint of endpoints) {
    const res = await fetch(endpoint.url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "x-api-key": apiKey
      }
    });

    if (res.status === 401 || res.status === 403) {
      throw new Error("auth failed");
    }
    if (!res.ok) {
      throw new Error(`Immich responded with ${res.status} on ${endpoint.label} albums`);
    }

    const albums = await res.json();
    const match = Array.isArray(albums)
      ? albums.find((album) => album?.albumName?.toLowerCase() === username.toLowerCase())
      : null;

    if (match) {
      return { match, source: endpoint.label };
    }
  }

  return null;
}

function showStatus(message, type) {
  statusEl.textContent = message;
  statusEl.classList.remove("success", "error");
  if (type === "success") statusEl.classList.add("success");
  if (type === "error") statusEl.classList.add("error");
}

function populatePresets() {
  PRESETS.filter((p) => p.apiKey).forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.label;
    opt.textContent = p.label;
    presetSelect.appendChild(opt);
  });
}
