// MV3 service worker. The agent does NOT run here — extension service workers
// can't host Web Workers and disallow `unsafe-eval`. Action click opens the
// chat in a normal extension page tab where a Worker can run.
chrome.action.onClicked.addListener(async () => {
	await chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
});
