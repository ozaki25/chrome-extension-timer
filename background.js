const ALARM_NAME = 'overlay-timer-finish';

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_TIMER' });
  } catch (e) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['lib.js', 'content.js']
      });
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['overlay.css']
      });
      await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_TIMER' });
    } catch (err) {
      console.warn('Overlay Timer: このページには注入できません', err);
    }
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'SCHEDULE_FINISH' && typeof msg.when === 'number') {
    chrome.alarms.clear(ALARM_NAME, () => {
      chrome.alarms.create(ALARM_NAME, { when: msg.when });
    });
  } else if (msg?.type === 'CANCEL_FINISH') {
    chrome.alarms.clear(ALARM_NAME);
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (!t.id) continue;
    chrome.tabs.sendMessage(t.id, { type: 'TIMER_FINISHED' }).catch(() => {});
  }
});
