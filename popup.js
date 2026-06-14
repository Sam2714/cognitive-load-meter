"use strict";

const popupState = {
  settings: {
    trackingEnabled: false,
    firstRunCompleted: false
  },
  live: {
    score: 0,
    status: "Low",
    trackingEnabled: false,
    currentDomainProfile: null,
    signalCounts: {
      switches10m: 0,
      bursts5m: 0,
      idleMinutes10m: 0
    }
  }
};

const elements = {
  welcomeView: document.getElementById("welcomeView"),
  dashboardView: document.getElementById("dashboardView"),
  startTrackingButton: document.getElementById("welcomeView"),
  scoreRing: document.getElementById("scoreRing"),
  statusValue: document.getElementById("statusValue"),
  statusDescription: document.getElementById("statusDescription")
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function shouldShowWelcome() {
  const params = new URLSearchParams(window.location.search);
  return params.get("view") === "welcome" || !popupState.settings.firstRunCompleted || !popupState.settings.trackingEnabled;
}

function stateLabel(status) {
  if (status === "High") {
    return "Overloaded";
  }

  if (status === "Medium") {
    return "Moderate";
  }

  return "Calm";
}

function stateColor(status) {
  if (status === "High") {
    return "#f87171";
  }

  if (status === "Medium") {
    return "#fcd34d";
  }

  return "#4ade80";
}

function shortInsight() {
  if (!popupState.settings.trackingEnabled) {
    return "Tap to start tracking";
  }

  const signals = popupState.live.signalCounts || {};
  const domainProfile = popupState.live.currentDomainProfile;

  if (popupState.live.status === "High") {
    if (domainProfile?.tendency === "heavy" && domainProfile.confidence >= 35) {
      return "This site feels heavy";
    }

    if ((signals.bursts5m || 0) >= (signals.switches10m || 0) && (signals.bursts5m || 0) > 0) {
      return "Scanning is moving fast";
    }

    return "Take one quiet minute";
  }

  if (popupState.live.status === "Medium") {
    if ((signals.switches10m || 0) > (signals.bursts5m || 0)) {
      return "Too much tab hopping";
    }

    if (domainProfile?.tendency === "heavy" && domainProfile.confidence >= 35) {
      return "Pressure rises here faster";
    }

    return "Pressure is quietly building";
  }

  if ((signals.idleMinutes10m || 0) > 0) {
    return "Recovery is helping";
  }

  if (domainProfile?.tendency === "calm" && domainProfile.confidence >= 35) {
    return "This site feels lighter";
  }

  return "Rhythm feels steady";
}

function render() {
  const showWelcome = shouldShowWelcome();
  elements.welcomeView.hidden = !showWelcome;
  elements.dashboardView.hidden = showWelcome;

  if (showWelcome) {
    return;
  }

  const score = clamp(Math.round(popupState.live.score || 0), 0, 100);
  const color = stateColor(popupState.live.status);
  const progress = `${Math.max(score * 3.6, 18)}deg`;

  elements.scoreRing.style.setProperty("--ring-color", color);
  elements.scoreRing.style.setProperty("--ring-progress", progress);
  elements.dashboardView.dataset.state = stateLabel(popupState.live.status).toLowerCase();
  elements.statusValue.textContent = stateLabel(popupState.live.status);
  elements.statusDescription.textContent = shortInsight();
}

async function fetchState() {
  const response = await chrome.runtime.sendMessage({ type: "GET_DASHBOARD_STATE" });

  if (!response) {
    return;
  }

  popupState.settings = {
    ...popupState.settings,
    ...(response.settings || {})
  };
  popupState.live = {
    ...popupState.live,
    ...(response.live || {}),
    signalCounts: {
      ...popupState.live.signalCounts,
      ...(response.live?.signalCounts || {})
    }
  };
}

elements.startTrackingButton.addEventListener("click", async () => {
  const live = await chrome.runtime.sendMessage({
    type: "TOGGLE_TRACKING",
    enabled: true
  });

  popupState.settings.trackingEnabled = true;
  popupState.settings.firstRunCompleted = true;
  popupState.live = {
    ...popupState.live,
    ...(live || {})
  };
  history.replaceState({}, "", "popup.html");
  await fetchState();
  render();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "LIVE_STATE_UPDATED" || !message.payload) {
    return;
  }

  popupState.live = {
    ...popupState.live,
    ...message.payload,
    signalCounts: {
      ...popupState.live.signalCounts,
      ...(message.payload.signalCounts || {})
    }
  };
  popupState.settings.trackingEnabled = Boolean(message.payload.trackingEnabled);
  render();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes.settings?.newValue) {
    popupState.settings = {
      ...popupState.settings,
      ...changes.settings.newValue
    };
    render();
  }
});

(async () => {
  await fetchState();
  render();
})().catch((error) => {
  console.error("Cognitive Load Meter popup failed to load", error);
});
