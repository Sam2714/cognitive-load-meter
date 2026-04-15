"use strict";

const settingsState = {
  settings: {
    trackingEnabled: false,
    suggestionsEnabled: true,
    interventionThreshold: 70,
    breakDurationSeconds: 60,
    focusOverlayStrength: 24,
    indicatorPosition: "bottom-right"
  },
  summary: null
};

const elements = {
  trackingToggle: document.getElementById("trackingToggle"),
  suggestionsToggle: document.getElementById("suggestionsToggle"),
  interventionThreshold: document.getElementById("interventionThreshold"),
  interventionThresholdValue: document.getElementById("interventionThresholdValue"),
  breakDurationSeconds: document.getElementById("breakDurationSeconds"),
  breakDurationValue: document.getElementById("breakDurationValue"),
  focusOverlayStrength: document.getElementById("focusOverlayStrength"),
  focusOverlayValue: document.getElementById("focusOverlayValue"),
  indicatorPosition: document.getElementById("indicatorPosition"),
  summarySwitches: document.getElementById("summarySwitches"),
  summaryBursts: document.getElementById("summaryBursts"),
  summaryBreaks: document.getElementById("summaryBreaks"),
  summaryFocusUses: document.getElementById("summaryFocusUses"),
  saveSettingsButton: document.getElementById("saveSettingsButton"),
  resetTodayButton: document.getElementById("resetTodayButton"),
  reloadButton: document.getElementById("reloadButton"),
  openPopupButton: document.getElementById("openPopupButton"),
  toast: document.getElementById("toast")
};

let toastTimer = null;

function updateToggle(button, enabled, activeLabel, inactiveLabel) {
  button.textContent = enabled ? activeLabel : inactiveLabel;
  button.classList.toggle("is-active", enabled);
}

function renderSummary() {
  const summary = settingsState.summary || {
    tabSwitches: 0,
    scrollBursts: 0,
    breakSessions: 0,
    focusModeUses: 0
  };

  elements.summarySwitches.textContent = String(summary.tabSwitches || 0);
  elements.summaryBursts.textContent = String(summary.scrollBursts || 0);
  elements.summaryBreaks.textContent = String(summary.breakSessions || 0);
  elements.summaryFocusUses.textContent = String(summary.focusModeUses || 0);
}

function renderSettings() {
  updateToggle(elements.trackingToggle, settingsState.settings.trackingEnabled, "Tracking On", "Tracking Off");
  updateToggle(elements.suggestionsToggle, settingsState.settings.suggestionsEnabled, "Enabled", "Disabled");
  elements.interventionThreshold.value = String(settingsState.settings.interventionThreshold);
  elements.interventionThresholdValue.textContent = String(settingsState.settings.interventionThreshold);
  elements.breakDurationSeconds.value = String(settingsState.settings.breakDurationSeconds);
  elements.breakDurationValue.textContent = `${settingsState.settings.breakDurationSeconds}s`;
  elements.focusOverlayStrength.value = String(settingsState.settings.focusOverlayStrength);
  elements.focusOverlayValue.textContent = `${settingsState.settings.focusOverlayStrength}%`;
  elements.indicatorPosition.value = settingsState.settings.indicatorPosition;
  renderSummary();
}

function collectSettings() {
  return {
    trackingEnabled: settingsState.settings.trackingEnabled,
    suggestionsEnabled: settingsState.settings.suggestionsEnabled,
    interventionThreshold: Number(elements.interventionThreshold.value),
    breakDurationSeconds: Number(elements.breakDurationSeconds.value),
    focusOverlayStrength: Number(elements.focusOverlayStrength.value),
    indicatorPosition: elements.indicatorPosition.value
  };
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;

  if (toastTimer) {
    clearTimeout(toastTimer);
  }

  toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 2200);
}

async function hydrate() {
  const response = await chrome.runtime.sendMessage({ type: "GET_DASHBOARD_STATE" });

  if (!response) {
    return;
  }

  settingsState.settings = {
    ...settingsState.settings,
    ...(response.settings || {})
  };
  settingsState.summary = response.summary || settingsState.summary;
  renderSettings();
}

elements.trackingToggle.addEventListener("click", () => {
  settingsState.settings.trackingEnabled = !settingsState.settings.trackingEnabled;
  renderSettings();
});

elements.suggestionsToggle.addEventListener("click", () => {
  settingsState.settings.suggestionsEnabled = !settingsState.settings.suggestionsEnabled;
  renderSettings();
});

elements.interventionThreshold.addEventListener("input", () => {
  elements.interventionThresholdValue.textContent = elements.interventionThreshold.value;
});

elements.breakDurationSeconds.addEventListener("input", () => {
  elements.breakDurationValue.textContent = `${elements.breakDurationSeconds.value}s`;
});

elements.focusOverlayStrength.addEventListener("input", () => {
  elements.focusOverlayValue.textContent = `${elements.focusOverlayStrength.value}%`;
});

elements.saveSettingsButton.addEventListener("click", async () => {
  settingsState.settings = {
    ...settingsState.settings,
    ...collectSettings()
  };

  await chrome.runtime.sendMessage({
    type: "SAVE_SETTINGS",
    settings: settingsState.settings
  });

  await hydrate();
  showToast("Settings saved");
});

elements.resetTodayButton.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "RESET_TODAY_SUMMARY" });
  await hydrate();
  showToast("Today's snapshot was reset");
});

elements.reloadButton.addEventListener("click", async () => {
  await hydrate();
  showToast("Snapshot refreshed");
});

elements.openPopupButton.addEventListener("click", () => {
  window.location.href = "popup.html";
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes.settings?.newValue) {
    settingsState.settings = {
      ...settingsState.settings,
      ...changes.settings.newValue
    };
  }

  if (changes.todaySummary?.newValue) {
    settingsState.summary = changes.todaySummary.newValue;
  }

  renderSettings();
});

hydrate().catch((error) => {
  console.error("Cognitive Load Meter settings failed to load", error);
});
