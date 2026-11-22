// Clicking the toolbar icon opens the signing editor in a new tab.
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("editor.html") });
});
