"use strict";

const popupState = {
  settings: {
    trackingEnabled: false,
    firstRunCompleted: false,
    suggestionsEnabled: true,
    interventionThreshold: 70,
    breakDurationSeconds: 60,
    indicatorPosition: "bottom-right",
    focusOverlayStrength: 24
  },
  summary: null,
  live: {
    score: 0,
    status: "Low",
    trackingEnabled: false,
    interventionEligible: false,
    focusModeActive: false,
    recentScores: [],
    signalCounts: {
      switches10m: 0,
      bursts5m: 0,
      flips5m: 0,
      idleMinutes10m: 0
    }
  },
  activeTabId: null,
  debugClicks: 0,
  debugTimer: null
};

const elements = {
  welcomeView: document.getElementById("welcomeView"),
  dashboardView: document.getElementById("dashboardView"),
  debugDrawer: document.getElementById("debugDrawer"),
  brandTapTarget: document.getElementById("brandTapTarget"),
  settingsButton: document.getElementById("settingsButton"),
  trackingToggle: document.getElementById("trackingToggle"),
  startTrackingButton: document.getElementById("startTrackingButton"),
  scoreRing: document.getElementById("scoreRing"),
  scoreValue: document.getElementById("scoreValue"),
  statusValue: document.getElementById("statusValue"),
  statusDescription: document.getElementById("statusDescription"),
  focusBadge: document.getElementById("focusBadge"),
  metricSwitches: document.getElementById("metricSwitches"),
  metricRecovery: document.getElementById("metricRecovery"),
  metricBreaks: document.getElementById("metricBreaks"),
  metricPeak: document.getElementById("metricPeak"),
  trendCanvas: document.getElementById("trendCanvas"),
  patternBars: document.getElementById("patternBars"),
  dateLabel: document.getElementById("dateLabel"),
  insightsList: document.getElementById("insightsList"),
  focusModeButton: document.getElementById("focusModeButton"),
  openOptionsButton: document.getElementById("openOptionsButton"),
  resetTodayButton: document.getElementById("resetTodayButton"),
  debugResetTodayButton: document.getElementById("debugResetTodayButton")
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function scoreColor(status) {
  if (status === "High") {
    return "#ef4444";
  }

  if (status === "Medium") {
    return "#facc15";
  }

  return "#22c55e";
}

function statusDescription(status, trackingEnabled) {
  if (!trackingEnabled) {
    return "Tracking is paused. Turn it back on whenever you want live guidance again.";
  }

  if (status === "High") {
    return "Your recent interaction pattern looks dense. A short reset could lower the friction quickly.";
  }

  if (status === "Medium") {
    return "Some cognitive pressure is building. Staying on one thread may help keep things calm.";
  }

  return "Your browsing rhythm looks steady and manageable.";
}

function formatDateLabel(dateKey) {
  if (!dateKey) {
    return "Today";
  }

  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(year, (month || 1) - 1, day || 1);

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric"
  });
}

function shouldShowWelcome() {
  const params = new URLSearchParams(window.location.search);
  return params.get("view") === "welcome" || !popupState.settings.firstRunCompleted;
}

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id ?? null;
}

async function fetchDashboardState() {
  popupState.activeTabId = await getActiveTabId();
  const response = await chrome.runtime.sendMessage({
    type: "GET_DASHBOARD_STATE",
    tabId: popupState.activeTabId
  });

  if (!response) {
    return;
  }

  popupState.settings = {
    ...popupState.settings,
    ...(response.settings || {})
  };
  popupState.summary = response.summary || popupState.summary;
  popupState.live = {
    ...popupState.live,
    ...(response.live || {})
  };
}

function renderViews() {
  const showWelcome = shouldShowWelcome();
  elements.welcomeView.hidden = !showWelcome;
  elements.dashboardView.hidden = showWelcome;
}

function renderTrackingToggle() {
  const enabled = Boolean(popupState.settings.trackingEnabled);
  elements.trackingToggle.textContent = enabled ? "Tracking On" : "Tracking Off";
  elements.trackingToggle.classList.toggle("is-active", enabled);
  elements.trackingToggle.setAttribute("aria-pressed", String(enabled));
}

function renderHero() {
  const score = clamp(Math.round(popupState.live.score || 0), 0, 100);
  const color = scoreColor(popupState.live.status);

  elements.scoreValue.textContent = String(score);
  elements.statusValue.textContent = popupState.live.status;
  elements.statusDescription.textContent = statusDescription(
    popupState.live.status,
    popupState.settings.trackingEnabled
  );
  elements.focusBadge.textContent = popupState.live.focusModeActive ? "Focus mode on" : "Focus mode off";
  elements.scoreRing.style.setProperty("--ring-progress", `${score * 3.6}deg`);
  elements.scoreRing.style.setProperty("--ring-color", color);
}

function renderMetrics() {
  const summary = popupState.summary || {
    tabSwitches: 0,
    idleMinutes: 0,
    breakSessions: 0,
    hourlyScores: []
  };

  const peak = Math.max(
    ...(summary.hourlyScores || [0]),
    ...(popupState.live.recentScores || []).map((entry) => entry.score || 0),
    0
  );

  elements.metricSwitches.textContent = String(summary.tabSwitches || 0);
  elements.metricRecovery.textContent = `${summary.idleMinutes || 0}m`;
  elements.metricBreaks.textContent = String(summary.breakSessions || 0);
  elements.metricPeak.textContent = String(Math.round(peak));
}

function drawTrendChart() {
  const canvas = elements.trendCanvas;
  const context = canvas.getContext("2d");
  const recentScores = popupState.live.recentScores || [];
  const scores = recentScores.length > 1 ? recentScores.map((entry) => entry.score) : [0, popupState.live.score || 0];
  const bounds = canvas.getBoundingClientRect();
  const width = Math.max(Math.round(bounds.width || 320), 280);
  const height = Math.max(Math.round(bounds.height || 92), 92);

  canvas.width = width;
  canvas.height = height;
  context.clearRect(0, 0, width, height);

  const padding = 8;
  const points = scores.map((score, index) => ({
    x: padding + (index / Math.max(scores.length - 1, 1)) * (width - padding * 2),
    y: height - padding - (clamp(score, 0, 100) / 100) * (height - padding * 2)
  }));

  const gradient = context.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "rgba(34, 197, 94, 0.28)");
  gradient.addColorStop(1, "rgba(34, 197, 94, 0.01)");

  context.beginPath();
  context.moveTo(points[0].x, height - padding);
  points.forEach((point) => context.lineTo(point.x, point.y));
  context.lineTo(points[points.length - 1].x, height - padding);
  context.closePath();
  context.fillStyle = gradient;
  context.fill();

  context.beginPath();
  points.forEach((point, index) => {
    if (index === 0) {
      context.moveTo(point.x, point.y);
    } else {
      context.lineTo(point.x, point.y);
    }
  });
  context.strokeStyle = "#22c55e";
  context.lineWidth = 2;
  context.lineJoin = "round";
  context.lineCap = "round";
  context.stroke();

  const thresholdY = height - padding - (70 / 100) * (height - padding * 2);
  context.beginPath();
  context.setLineDash([3, 4]);
  context.moveTo(0, thresholdY);
  context.lineTo(width, thresholdY);
  context.strokeStyle = "rgba(239, 68, 68, 0.26)";
  context.lineWidth = 1;
  context.stroke();
  context.setLineDash([]);

  const lastPoint = points[points.length - 1];
  context.beginPath();
  context.arc(lastPoint.x, lastPoint.y, 4, 0, Math.PI * 2);
  context.fillStyle = "#22c55e";
  context.shadowColor = "#22c55e";
  context.shadowBlur = 12;
  context.fill();
  context.shadowBlur = 0;
}

function renderPattern() {
  const hourlyScores = popupState.summary?.hourlyScores || Array(24).fill(0);
  const maxScore = Math.max(...hourlyScores, 20);
  elements.patternBars.textContent = "";

  hourlyScores.forEach((score, hour) => {
    const bar = document.createElement("div");
    bar.className = "pattern-bar";
    bar.style.height = `${Math.max(12, Math.round((score / maxScore) * 100))}%`;
    bar.style.background = score >= 70 ? "#ef4444" : score >= 35 ? "#facc15" : "#22c55e";
    bar.title = `${String(hour).padStart(2, "0")}:00 - score ${Math.round(score)}`;
    elements.patternBars.appendChild(bar);
  });

  elements.dateLabel.textContent = formatDateLabel(popupState.summary?.dateKey);
}

function buildInsights() {
  const summary = popupState.summary;
  const liveSignals = popupState.live.signalCounts || {};

  if (!summary) {
    return [
      "Tracking will start building same-day patterns once you browse with it enabled.",
      "Insights stay local and rely only on interaction summaries, not page content.",
      "Use the floating meter as a soft cue, not a rigid judgment."
    ];
  }

  const insights = [];
  const scanningPressure = (summary.scrollBursts || 0) + (summary.directionFlips || 0);
  const switchingPressure = summary.tabSwitches || 0;
  const recoverySignal = summary.idleMinutes || 0;

  if (switchingPressure >= scanningPressure && switchingPressure >= recoverySignal && switchingPressure > 0) {
    insights.push("Tab switching is the strongest load driver in your day so far.");
  }

  if (scanningPressure > switchingPressure && scanningPressure >= recoverySignal && scanningPressure > 0) {
    insights.push("Rapid scanning and backtracking are creating most of the current pressure.");
  }

  if (recoverySignal > 0) {
    insights.push("Idle moments are helping your score recover between heavier bursts.");
  }

  if (popupState.live.status === "High") {
    insights.push("You are in a high-load window right now. A short reset or focus mode may help immediately.");
  } else if (popupState.live.status === "Medium") {
    insights.push("Your load is moderate right now. Staying on one tab cluster could keep it from climbing.");
  } else {
    insights.push("Your current state looks calm. This is a good moment for deeper work.");
  }

  if ((summary.focusModeUses || 0) > 0) {
    insights.push("Focus mode has already helped at least once today, which is a good sign the intervention feels useful.");
  }

  if ((summary.interventionsShown || 0) > 0 && liveSignals.switches10m === 0 && liveSignals.bursts5m === 0) {
    insights.push("The current window looks quieter than the earlier intervention moments today.");
  }

  return insights.slice(0, 3);
}

function renderInsights() {
  elements.insightsList.textContent = "";

  buildInsights().forEach((insight) => {
    const item = document.createElement("div");
    item.className = "insight-item";
    item.textContent = insight;
    elements.insightsList.appendChild(item);
  });
}

function renderActions() {
  const trackingEnabled = Boolean(popupState.settings.trackingEnabled);
  elements.focusModeButton.disabled = !trackingEnabled || popupState.activeTabId === null;
  elements.focusModeButton.textContent = popupState.live.focusModeActive ? "Turn Off Focus" : "Focus Current Tab";
}

function renderDebugDrawer() {
  if (!popupState.settings.debugEnabled) {
    return;
  }

  elements.debugDrawer.hidden = false;
}

function renderAll() {
  renderTrackingToggle();
  renderViews();

  if (!elements.dashboardView.hidden) {
    renderHero();
    renderMetrics();
    drawTrendChart();
    renderPattern();
    renderInsights();
    renderActions();
  }

  renderDebugDrawer();
}

async function resetToday() {
  await chrome.runtime.sendMessage({ type: "RESET_TODAY_SUMMARY" });
  await fetchDashboardState();
  renderAll();
}

function openSettingsPage() {
  chrome.runtime.openOptionsPage();
}

elements.startTrackingButton.addEventListener("click", async () => {
  popupState.live = await chrome.runtime.sendMessage({
    type: "TOGGLE_TRACKING",
    enabled: true
  });

  popupState.settings.trackingEnabled = true;
  popupState.settings.firstRunCompleted = true;
  history.replaceState({}, "", "popup.html");
  await fetchDashboardState();
  renderAll();
});

elements.trackingToggle.addEventListener("click", async () => {
  const nextEnabled = !popupState.settings.trackingEnabled;
  popupState.live = await chrome.runtime.sendMessage({
    type: "TOGGLE_TRACKING",
    enabled: nextEnabled
  });
  popupState.settings.trackingEnabled = nextEnabled;

  if (nextEnabled) {
    popupState.settings.firstRunCompleted = true;
  }

  await fetchDashboardState();
  renderAll();
});

elements.focusModeButton.addEventListener("click", async () => {
  if (popupState.activeTabId === null) {
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: "TOGGLE_FOCUS_MODE",
    tabId: popupState.activeTabId,
    enabled: !popupState.live.focusModeActive
  });

  if (response?.ok) {
    popupState.live.focusModeActive = response.focusModeActive;
    renderAll();
  }
});

elements.settingsButton.addEventListener("click", openSettingsPage);
elements.openOptionsButton.addEventListener("click", openSettingsPage);
elements.resetTodayButton.addEventListener("click", resetToday);
elements.debugResetTodayButton.addEventListener("click", resetToday);

elements.brandTapTarget.addEventListener("click", () => {
  popupState.debugClicks += 1;

  if (popupState.debugTimer) {
    clearTimeout(popupState.debugTimer);
  }

  popupState.debugTimer = window.setTimeout(() => {
    popupState.debugClicks = 0;
  }, 1500);

  if (popupState.debugClicks >= 5) {
    popupState.debugClicks = 0;
    elements.debugDrawer.hidden = !elements.debugDrawer.hidden;
  }
});

elements.debugDrawer.addEventListener("click", async (event) => {
  const mode = event.target.closest("[data-debug-mode]")?.dataset.debugMode;

  if (!mode) {
    return;
  }

  await chrome.runtime.sendMessage({
    type: "SET_DEBUG_STATE",
    mode
  });
  await fetchDashboardState();
  renderAll();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "LIVE_STATE_UPDATED" && message.payload) {
    popupState.live = {
      ...popupState.live,
      ...message.payload
    };
    renderAll();
  }
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
  }

  if (changes.todaySummary?.newValue) {
    popupState.summary = changes.todaySummary.newValue;
  }

  renderAll();
});

(async () => {
  await fetchDashboardState();
  renderAll();
})().catch((error) => {
  console.error("Cognitive Load Meter popup failed to load", error);
});
