// Saved signatures live only in this browser profile: chrome.storage.local in
// the extension, localStorage on the web version. The web version shares its
// origin (dotori-forest.github.io) with every other Pages site of the account,
// so its key is namespaced and everything read back is validated.
import { cleanSignatures } from "./signatureBackup.js";

const CHROME_KEY = "signatures";
const WEB_KEY = "gakin.signatures";
const LEGACY_WEB_KEY = "signatures"; // before 2026-11, read once to migrate
const hasChromeStorage = typeof chrome !== "undefined" && chrome.storage?.local;

export const MAX_SIGNATURES = 12;

export async function loadSignatures() {
  try {
    if (hasChromeStorage) {
      const data = await chrome.storage.local.get(CHROME_KEY);
      return cleanSignatures(data[CHROME_KEY]).slice(0, MAX_SIGNATURES);
    }
    const raw = localStorage.getItem(WEB_KEY) ?? localStorage.getItem(LEGACY_WEB_KEY);
    return raw ? cleanSignatures(JSON.parse(raw)).slice(0, MAX_SIGNATURES) : [];
  } catch {
    return [];
  }
}

export async function saveSignatures(list) {
  if (hasChromeStorage) {
    await chrome.storage.local.set({ [CHROME_KEY]: list });
  } else {
    localStorage.setItem(WEB_KEY, JSON.stringify(list));
  }
}
