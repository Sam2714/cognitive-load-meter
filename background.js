"use strict";

const STORAGE_KEYS = {
  settings: "settings",
  todaySummary: "todaySummary",
  rollingState: "rollingState"
};

const ALARM_NAME = "clm-maintenance";
const TAB_WINDOW_MS = 10 * 60 * 1000;
const SCROLL_WINDOW_MS = 5 * 60 * 1000;
const IDLE_WINDOW_MS = 10 * 60 * 1000;
const SESSION_TREND_WINDOW_MS = 12 * 60 * 60 * 1000;
const SUMMARY_FLUSH_INTERVAL_MS = 15 * 1000;
const TAB_SWITCH_COOLDOWN_MS = 2 * 1000;
const INTERVENTION_COOLDOWN_MS = 15 * 60 * 1000;
const SCORE_SAMPLE_INTERVAL_MS = 45 * 1000;
const VALID_POSITIONS = new Set(["bottom-right", "bottom-left", "top-right", "top-left"]);

let initializationPromise = null;
let mutationQueue = Promise.resolve();

function enqueueMutation(task) {
  mutationQueue = mutationQueue.then(task, task);
  return mutationQueue;
}

function getDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function statusFromScore(score) {
  if (score >= 70) {
    return "High";
  }

  if (score >= 35) {
    return "Medium";
  }

  return "Low";
}

function createDefaultSettings() {
  return {
    trackingEnabled: false,
    firstRunCompleted: false,
    debugEnabled: false,
    suggestionsEnabled: true,
    interventionThreshold: 70,
    breakDurationSeconds: 60,
    indicatorPosition: "bottom-right",
    focusOverlayStrength: 24,
    installDate: new Date().toISOString()
  };
}

function createDefaultTodaySummary(dateKey = getDateKey()) {
  return {
    dateKey,
    tabSwitches: 0,
    idleMinutes: 0,
    scrollBursts: 0,
    directionFlips: 0,
    focusModeUses: 0,
    breakSessions: 0,
    interventionsShown: 0,
    hourlyScores: Array(24).fill(0),
    hourlyHighEntries: Array(24).fill(0),
    hourlySampleCounts: Array(24).fill(0)
  };
}

function createPendingSummary() {
  return {
    tabSwitches: 0,
    idleMinutes: 0,
    scrollBursts: 0,
    directionFlips: 0,
    focusModeUses: 0,
    breakSessions: 0,
    interventionsShown: 0,
    hourlyScoreTotals: Array(24).fill(0),
    hourlyScoreCounts: Array(24).fill(0),
    hourlyHighEntries: Array(24).fill(0)
  };
}

function createDefaultRollingState() {
  return {
    tabSwitchEvents: [],
    scrollEvents: [],
    idleMinuteStamps: [],
    recentScores: [],
    currentScore: 0,
    currentStatus: "Low",
    activeTabId: null,
    lastTabSwitchAt: 0,
    lastInterventionAt: 0,
    suppressionUntil: 0,
    suppressedWhileHigh: false,
    focusModeTabs: {},
    currentIdleState: "active",
    lastIdleMinuteStamp: 0,
    lastScoreSampleAt: 0,
    lastSummaryWriteAt: 0,
    sessionStartedAt: Date.now(),
    debugOverride: null,
    pendingSummary: createPendingSummary()
  };
}

function normalizeArray(source, size, fallback = 0) {
  const output = Array.isArray(source) ? source.slice(0, size) : [];

  while (output.length < size) {
    output.push(fallback);
  }

  return output;
}

function sanitizeSettings(settings) {
  const defaults = createDefaultSettings();
  const merged = {
    ...defaults,
    ...(settings || {})
  };

  merged.trackingEnabled = Boolean(merged.trackingEnabled);
  merged.firstRunCompleted = Boolean(merged.firstRunCompleted);
  merged.debugEnabled = Boolean(merged.debugEnabled);
  merged.suggestionsEnabled = merged.suggestionsEnabled !== false;
  merged.interventionThreshold = clamp(Number(merged.interventionThreshold || defaults.interventionThreshold), 60, 85);
  merged.breakDurationSeconds = clamp(Number(merged.breakDurationSeconds || defaults.breakDurationSeconds), 45, 180);
  merged.focusOverlayStrength = clamp(Number(merged.focusOverlayStrength || defaults.focusOverlayStrength), 12, 40);
  merged.indicatorPosition = VALID_POSITIONS.has(merged.indicatorPosition)
    ? merged.indicatorPosition
    : defaults.indicatorPosition;
  merged.installDate = typeof merged.installDate === "string" ? merged.installDate : defaults.installDate;

  return merged;
}

function normalizePendingSummary(summary) {
  return {
    tabSwitches: Number(summary?.tabSwitches || 0),
    idleMinutes: Number(summary?.idleMinutes || 0),
    scrollBursts: Number(summary?.scrollBursts || 0),
    directionFlips: Number(summary?.directionFlips || 0),
    focusModeUses: Number(summary?.focusModeUses || 0),
    breakSessions: Number(summary?.breakSessions || 0),
    interventionsShown: Number(summary?.interventionsShown || 0),
    hourlyScoreTotals: normalizeArray(summary?.hourlyScoreTotals, 24, 0),
    hourlyScoreCounts: normalizeArray(summary?.hourlyScoreCounts, 24, 0),
    hourlyHighEntries: normalizeArray(summary?.hourlyHighEntries, 24, 0)
  };
}

function normalizeTodaySummary(summary) {
  const base = createDefaultTodaySummary(summary?.dateKey || getDateKey());

  return {
    ...base,
    ...summary,
    hourlyScores: normalizeArray(summary?.hourlyScores, 24, 0),
    hourlyHighEntries: normalizeArray(summary?.hourlyHighEntries, 24, 0),
    hourlySampleCounts: normalizeArray(summary?.hourlySampleCounts, 24, 0)
  };
}

function normalizeRollingState(state) {
  const base = createDefaultRollingState();

  return {
    ...base,
    ...state,
    tabSwitchEvents: Array.isArray(state?.tabSwitchEvents)
      ? state.tabSwitchEvents.filter(Boolean).map((value) => Number(value))
      : [],
    scrollEvents: Array.isArray(state?.scrollEvents)
      ? state.scrollEvents
          .filter((event) => event && Number.isFinite(event.timestamp))
          .map((event) => ({
            timestamp: Number(event.timestamp),
            burst: Boolean(event.burst),
            flips: Number(event.flips || 0),
            velocity: Number(event.velocity || 0)
          }))
      : [],
    idleMinuteStamps: Array.isArray(state?.idleMinuteStamps)
      ? state.idleMinuteStamps.filter(Boolean).map((value) => Number(value))
      : [],
    recentScores: Array.isArray(state?.recentScores)
      ? state.recentScores
          .filter((entry) => entry && Number.isFinite(entry.timestamp) && Number.isFinite(entry.score))
          .map((entry) => ({
            timestamp: Number(entry.timestamp),
            score: clamp(Number(entry.score), 0, 100)
          }))
      : [],
    focusModeTabs: typeof state?.focusModeTabs === "object" && state?.focusModeTabs ? state.focusModeTabs : {},
    pendingSummary: normalizePendingSummary(state?.pendingSummary)
  };
}

function countSignals(state) {
  return {
    switches10m: state.tabSwitchEvents.length,
    bursts5m: state.scrollEvents.reduce((total, event) => total + (event.burst ? 1 : 0), 0),
    flips5m: state.scrollEvents.reduce((total, event) => total + Number(event.flips || 0), 0),
    idleMinutes10m: state.idleMinuteStamps.length
  };
}

function shouldTrackScores(settings, state) {
  return settings.trackingEnabled || Boolean(state.debugOverride);
}

function isTrackingActive(settings, state) {
  return settings.trackingEnabled || Boolean(state.debugOverride);
}

function trimRollingState(state, now = Date.now()) {
  state.tabSwitchEvents = state.tabSwitchEvents.filter((timestamp) => now - timestamp <= TAB_WINDOW_MS);
  state.scrollEvents = state.scrollEvents.filter((event) => now - event.timestamp <= SCROLL_WINDOW_MS);
  state.idleMinuteStamps = state.idleMinuteStamps.filter((stamp) => now - stamp <= IDLE_WINDOW_MS);
  state.recentScores = state.recentScores
    .filter((entry) => now - entry.timestamp <= SESSION_TREND_WINDOW_MS)
    .slice(-120);
}

function addHourlyScoreSample(pendingSummary, score, now = Date.now()) {
  const hour = new Date(now).getHours();
  pendingSummary.hourlyScoreTotals[hour] += score;
  pendingSummary.hourlyScoreCounts[hour] += 1;
}

function addHourlyHighEntry(pendingSummary, now = Date.now()) {
  const hour = new Date(now).getHours();
  pendingSummary.hourlyHighEntries[hour] += 1;
}

function hasPendingSummary(summary) {
  if (
    summary.tabSwitches > 0 ||
    summary.idleMinutes > 0 ||
    summary.scrollBursts > 0 ||
    summary.directionFlips > 0 ||
    summary.focusModeUses > 0 ||
    summary.breakSessions > 0 ||
    summary.interventionsShown > 0
  ) {
    return true;
  }

  return summary.hourlyScoreCounts.some((count) => count > 0) || summary.hourlyHighEntries.some((count) => count > 0);
}

function sampleRecentScore(state, now, previousStatus, force) {
  const shouldSample =
    force ||
    state.recentScores.length === 0 ||
    now - state.lastScoreSampleAt >= SCORE_SAMPLE_INTERVAL_MS ||
    previousStatus !== state.currentStatus;

  if (!shouldSample) {
    return;
  }

  state.lastScoreSampleAt = now;
  state.recentScores.push({
    timestamp: now,
    score: state.currentScore
  });
  state.recentScores = state.recentScores
    .filter((entry) => now - entry.timestamp <= SESSION_TREND_WINDOW_MS)
    .slice(-120);
}

async function setSessionAccessLevel() {
  if (!chrome.storage.session?.setAccessLevel) {
    return;
  }

  try {
    await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch (error) {
    console.warn("Unable to restrict session storage access level", error);
  }
}

async function ensureAlarm() {
  const existingAlarm = await chrome.alarms.get(ALARM_NAME);

  if (!existingAlarm) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  }
}

async function ensureInitialized() {
  if (!initializationPromise) {
    initializationPromise = (async () => {
      await setSessionAccessLevel();

      const [localStore, sessionStore] = await Promise.all([
        chrome.storage.local.get([STORAGE_KEYS.settings, STORAGE_KEYS.todaySummary]),
        chrome.storage.session.get(STORAGE_KEYS.rollingState)
      ]);

      const localUpdates = {};
      const sessionUpdates = {};
      const todayKey = getDateKey();
      const settings = sanitizeSettings(localStore[STORAGE_KEYS.settings]);
      const summary = normalizeTodaySummary(localStore[STORAGE_KEYS.todaySummary]);
      const rollingState = normalizeRollingState(sessionStore[STORAGE_KEYS.rollingState]);

      if (!localStore[STORAGE_KEYS.settings]) {
        localUpdates[STORAGE_KEYS.settings] = settings;
      }

      if (!localStore[STORAGE_KEYS.todaySummary] || summary.dateKey !== todayKey) {
        localUpdates[STORAGE_KEYS.todaySummary] = createDefaultTodaySummary(todayKey);
        sessionUpdates[STORAGE_KEYS.rollingState] = {
          ...rollingState,
          pendingSummary: createPendingSummary()
        };
      }

      if (!sessionStore[STORAGE_KEYS.rollingState]) {
        sessionUpdates[STORAGE_KEYS.rollingState] = createDefaultRollingState();
      }

      if (Object.keys(localUpdates).length > 0) {
        await chrome.storage.local.set(localUpdates);
      }

      if (Object.keys(sessionUpdates).length > 0) {
        await chrome.storage.session.set(sessionUpdates);
      }

      await ensureAlarm();
    })().catch((error) => {
      initializationPromise = null;
      throw error;
    });
  }

  return initializationPromise;
}

async function getSettings() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return sanitizeSettings(result[STORAGE_KEYS.settings]);
}

async function getTodaySummary() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.todaySummary);
  const summary = normalizeTodaySummary(result[STORAGE_KEYS.todaySummary]);

  if (summary.dateKey !== getDateKey()) {
    const resetSummary = createDefaultTodaySummary();
    await chrome.storage.local.set({ [STORAGE_KEYS.todaySummary]: resetSummary });
    return resetSummary;
  }

  return summary;
}

async function getRollingState() {
  const result = await chrome.storage.session.get(STORAGE_KEYS.rollingState);
  const rollingState = normalizeRollingState(result[STORAGE_KEYS.rollingState]);

  if (!result[STORAGE_KEYS.rollingState]) {
    await chrome.storage.session.set({ [STORAGE_KEYS.rollingState]: rollingState });
  }

  return rollingState;
}

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id ?? null;
}

async function flushPendingSummary(state, options = {}) {
  const now = options.now || Date.now();
  const force = Boolean(options.force);

  if (!force && now - state.lastSummaryWriteAt < SUMMARY_FLUSH_INTERVAL_MS) {
    await chrome.storage.session.set({ [STORAGE_KEYS.rollingState]: state });
    return;
  }

  if (!hasPendingSummary(state.pendingSummary)) {
    state.lastSummaryWriteAt = now;
    await chrome.storage.session.set({ [STORAGE_KEYS.rollingState]: state });
    return;
  }

  const summary = await getTodaySummary();
  const pendingSummary = normalizePendingSummary(state.pendingSummary);

  summary.tabSwitches += pendingSummary.tabSwitches;
  summary.idleMinutes += pendingSummary.idleMinutes;
  summary.scrollBursts += pendingSummary.scrollBursts;
  summary.directionFlips += pendingSummary.directionFlips;
  summary.focusModeUses += pendingSummary.focusModeUses;
  summary.breakSessions += pendingSummary.breakSessions;
  summary.interventionsShown += pendingSummary.interventionsShown;

  for (let index = 0; index < 24; index += 1) {
    const addedCount = pendingSummary.hourlyScoreCounts[index];
    const addedTotal = pendingSummary.hourlyScoreTotals[index];

    if (addedCount > 0) {
      const existingCount = Number(summary.hourlySampleCounts[index] || 0);
      const existingAverage = Number(summary.hourlyScores[index] || 0);
      const mergedTotal = existingAverage * existingCount + addedTotal;
      const mergedCount = existingCount + addedCount;

      summary.hourlyScores[index] = Math.round(mergedTotal / mergedCount);
      summary.hourlySampleCounts[index] = mergedCount;
    }

    summary.hourlyHighEntries[index] += pendingSummary.hourlyHighEntries[index];
  }

  state.pendingSummary = createPendingSummary();
  state.lastSummaryWriteAt = now;

  await Promise.all([
    chrome.storage.local.set({ [STORAGE_KEYS.todaySummary]: summary }),
    chrome.storage.session.set({ [STORAGE_KEYS.rollingState]: state })
  ]);
}

function computeScore(state) {
  if (state.debugOverride && Number.isFinite(state.debugOverride.score) && state.debugOverride.status) {
    return {
      score: clamp(Number(state.debugOverride.score), 0, 100),
      status: state.debugOverride.status
    };
  }

  const signals = countSignals(state);
  const tabPressure = Math.min(40, signals.switches10m * 5);
  const scrollPressure = Math.min(45, signals.bursts5m * 6 + signals.flips5m * 2);
  const idleRelief = Math.min(30, signals.idleMinutes10m * 4 + (state.currentIdleState !== "active" ? 10 : 0));
  const rawScore = clamp(tabPressure + scrollPressure - idleRelief, 0, 100);
  const score = Math.round(state.currentScore * 0.7 + rawScore * 0.3);

  return {
    score,
    status: statusFromScore(score)
  };
}

function isInterventionEligible(state, settings) {
  if (!isTrackingActive(settings, state) || !settings.suggestionsEnabled) {
    return false;
  }

  if (state.debugOverride?.forceIntervention) {
    return true;
  }

  if (state.currentScore < settings.interventionThreshold) {
    return false;
  }

  if (state.suppressedWhileHigh && Date.now() < state.suppressionUntil) {
    return false;
  }

  return true;
}

function buildLiveStatePayload(state, settings, tabId) {
  const resolvedTabId = tabId ?? state.activeTabId;
  const focusModeActive = Boolean(resolvedTabId && state.focusModeTabs[String(resolvedTabId)]);
  const trackingActive = isTrackingActive(settings, state);

  return {
    score: trackingActive ? state.currentScore : 0,
    status: trackingActive ? state.currentStatus : "Low",
    trackingEnabled: trackingActive,
    interventionEligible: isInterventionEligible(state, settings),
    focusModeActive,
    activeTabId: resolvedTabId,
    lastInterventionAt: state.lastInterventionAt,
    recentScores: state.recentScores,
    sessionStartedAt: state.sessionStartedAt,
    signalCounts: countSignals(state),
    uiPreferences: {
      suggestionsEnabled: settings.suggestionsEnabled,
      interventionThreshold: settings.interventionThreshold,
      breakDurationSeconds: settings.breakDurationSeconds,
      indicatorPosition: settings.indicatorPosition,
      focusOverlayStrength: settings.focusOverlayStrength
    }
  };
}

async function broadcastLiveState(preloaded) {
  const settings = preloaded?.settings || (await getSettings());
  const state = preloaded?.state || (await getRollingState());
  const activeTabId = state.activeTabId ?? (await getActiveTabId());
  const activePayload = buildLiveStatePayload(state, settings, activeTabId);

  if (activeTabId !== state.activeTabId) {
    state.activeTabId = activeTabId;
    await chrome.storage.session.set({ [STORAGE_KEYS.rollingState]: state });
  }

  await chrome.runtime.sendMessage({
    type: "LIVE_STATE_UPDATED",
    payload: activePayload
  }).catch(() => undefined);

  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs
      .filter((tab) => typeof tab.id === "number")
      .map((tab) =>
        chrome.tabs.sendMessage(tab.id, {
          type: "LIVE_STATE_UPDATED",
          payload: buildLiveStatePayload(state, settings, tab.id)
        }).catch(() => undefined)
      )
  );
}

async function getDashboardState(tabId) {
  await ensureInitialized();
  const [settings, summary, state] = await Promise.all([getSettings(), getTodaySummary(), getRollingState()]);

  return {
    settings,
    summary,
    live: buildLiveStatePayload(state, settings, tabId)
  };
}

async function recalculateState(options = {}) {
  await ensureInitialized();

  const now = options.now || Date.now();
  const [settings, initialState] = await Promise.all([getSettings(), getRollingState()]);
  const state = normalizeRollingState(initialState);
  const previousStatus = state.currentStatus;

  trimRollingState(state, now);

  if (!settings.trackingEnabled && !state.debugOverride) {
    state.currentScore = 0;
    state.currentStatus = "Low";
    state.suppressedWhileHigh = false;
    state.suppressionUntil = 0;
  } else {
    const computed = computeScore(state);
    state.currentScore = computed.score;
    state.currentStatus = computed.status;
  }

  if (state.currentScore < Math.max(0, settings.interventionThreshold - 15)) {
    state.suppressedWhileHigh = false;
    state.suppressionUntil = 0;
  }

  if (shouldTrackScores(settings, state)) {
    addHourlyScoreSample(state.pendingSummary, state.currentScore, now);

    if (previousStatus !== "High" && state.currentStatus === "High") {
      addHourlyHighEntry(state.pendingSummary, now);
    }

    sampleRecentScore(state, now, previousStatus, Boolean(options.forceSample));
  }

  await flushPendingSummary(state, {
    now,
    force: Boolean(options.forceFlush) || previousStatus !== state.currentStatus
  });

  await broadcastLiveState({ settings, state });
  return {
    settings,
    state
  };
}

async function setTrackingEnabled(enabled) {
  await ensureInitialized();
  const [settings, currentState] = await Promise.all([getSettings(), getRollingState()]);

  settings.trackingEnabled = Boolean(enabled);

  if (settings.trackingEnabled) {
    settings.firstRunCompleted = true;
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
    await recalculateState({ forceFlush: true, forceSample: true });
    return buildLiveStatePayload(await getRollingState(), settings, currentState.activeTabId);
  }

  const resetState = createDefaultRollingState();
  resetState.activeTabId = currentState.activeTabId;

  await Promise.all([
    chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings }),
    chrome.storage.session.set({ [STORAGE_KEYS.rollingState]: resetState })
  ]);

  await broadcastLiveState({ settings, state: resetState });
  return buildLiveStatePayload(resetState, settings, currentState.activeTabId);
}

async function recordTabSwitch(tabId) {
  await ensureInitialized();
  const settings = await getSettings();

  if (!settings.trackingEnabled) {
    return;
  }

  const now = Date.now();
  const state = await getRollingState();

  if (tabId === state.activeTabId) {
    return;
  }

  state.activeTabId = tabId;

  if (now - state.lastTabSwitchAt < TAB_SWITCH_COOLDOWN_MS) {
    await chrome.storage.session.set({ [STORAGE_KEYS.rollingState]: state });
    await broadcastLiveState({ settings, state });
    return;
  }

  state.lastTabSwitchAt = now;
  state.tabSwitchEvents.push(now);
  state.pendingSummary.tabSwitches += 1;

  await chrome.storage.session.set({ [STORAGE_KEYS.rollingState]: state });
  await recalculateState();
}

async function recordScrollSample(sample) {
  await ensureInitialized();
  const settings = await getSettings();

  if (!settings.trackingEnabled) {
    return;
  }

  const state = await getRollingState();

  state.scrollEvents.push({
    timestamp: Number(sample.timestamp || Date.now()),
    burst: Boolean(sample.burst),
    flips: Number(sample.directionChanges > 3 ? sample.directionChanges : 0),
    velocity: Number(sample.velocity || 0)
  });

  if (sample.burst) {
    state.pendingSummary.scrollBursts += 1;
  }

  if (sample.directionChanges > 3) {
    state.pendingSummary.directionFlips += Number(sample.directionChanges);
  }

  await chrome.storage.session.set({ [STORAGE_KEYS.rollingState]: state });
  await recalculateState();
}

async function recordIdleMinute(now = Date.now()) {
  const state = await getRollingState();
  const minuteStamp = Math.floor(now / 60000) * 60000;

  if (state.lastIdleMinuteStamp === minuteStamp) {
    return;
  }

  state.lastIdleMinuteStamp = minuteStamp;
  state.idleMinuteStamps.push(minuteStamp);
  state.pendingSummary.idleMinutes += 1;

  await chrome.storage.session.set({ [STORAGE_KEYS.rollingState]: state });
}

async function handleIdleStateChanged(newState) {
  await ensureInitialized();
  const [settings, state] = await Promise.all([getSettings(), getRollingState()]);

  state.currentIdleState = newState;

  if (!settings.trackingEnabled) {
    await chrome.storage.session.set({ [STORAGE_KEYS.rollingState]: state });
    await broadcastLiveState({ settings, state });
    return;
  }

  if (newState !== "active") {
    await chrome.storage.session.set({ [STORAGE_KEYS.rollingState]: state });
    await recordIdleMinute();
  } else {
    state.lastIdleMinuteStamp = 0;
    await chrome.storage.session.set({ [STORAGE_KEYS.rollingState]: state });
  }

  await recalculateState({ forceFlush: true, forceSample: true });
}

async function acknowledgeIntervention(kind) {
  const state = await getRollingState();
  const now = Date.now();

  if (kind === "shown") {
    state.pendingSummary.interventionsShown += 1;
  }

  state.lastInterventionAt = now;
  state.suppressedWhileHigh = true;
  state.suppressionUntil = now + INTERVENTION_COOLDOWN_MS;

  if (state.debugOverride?.forceIntervention) {
    state.debugOverride = {
      score: Math.max(82, state.debugOverride.score || 82),
      status: "High",
      forceIntervention: false
    };
  }

  await flushPendingSummary(state, { force: kind === "shown" });
  await broadcastLiveState();
}

async function startBreakSession() {
  const state = await getRollingState();
  state.pendingSummary.breakSessions += 1;
  await flushPendingSummary(state, { force: true });
  await broadcastLiveState();
}

async function toggleFocusMode(tabId, enabled) {
  const settings = await getSettings();
  const state = await getRollingState();
  const key = String(tabId);
  const nextValue = typeof enabled === "boolean" ? enabled : !state.focusModeTabs[key];

  if (nextValue) {
    state.focusModeTabs[key] = true;
    state.pendingSummary.focusModeUses += 1;
  } else {
    delete state.focusModeTabs[key];
  }

  await flushPendingSummary(state, { force: true });
  await broadcastLiveState({ settings, state });

  return Boolean(state.focusModeTabs[key]);
}

async function setDebugState(mode) {
  const state = await getRollingState();

  if (mode === "low") {
    state.debugOverride = { score: 18, status: "Low", forceIntervention: false };
  } else if (mode === "medium") {
    state.debugOverride = { score: 52, status: "Medium", forceIntervention: false };
  } else if (mode === "high") {
    state.debugOverride = { score: 84, status: "High", forceIntervention: false };
  } else if (mode === "card") {
    state.debugOverride = { score: 82, status: "High", forceIntervention: true };
    state.suppressedWhileHigh = false;
    state.suppressionUntil = 0;
  } else {
    state.debugOverride = null;
  }

  await chrome.storage.session.set({ [STORAGE_KEYS.rollingState]: state });
  await recalculateState({ forceFlush: true, forceSample: true });
}

async function resetTodaySummary() {
  await chrome.storage.local.set({ [STORAGE_KEYS.todaySummary]: createDefaultTodaySummary() });

  const state = await getRollingState();
  state.pendingSummary = createPendingSummary();
  await chrome.storage.session.set({ [STORAGE_KEYS.rollingState]: state });
}

async function saveSettings(partialSettings) {
  const currentSettings = await getSettings();
  const nextSettings = sanitizeSettings({
    ...currentSettings,
    ...(partialSettings || {})
  });

  if (nextSettings.trackingEnabled) {
    nextSettings.firstRunCompleted = true;
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: nextSettings });

  if (!nextSettings.trackingEnabled) {
    const currentState = await getRollingState();
    const resetState = createDefaultRollingState();
    resetState.activeTabId = currentState.activeTabId;
    await chrome.storage.session.set({ [STORAGE_KEYS.rollingState]: resetState });
    await broadcastLiveState({ settings: nextSettings, state: resetState });
    return nextSettings;
  }

  await recalculateState({ forceFlush: true, forceSample: true });
  return nextSettings;
}

async function handleMaintenanceAlarm() {
  await ensureInitialized();
  const summary = await getTodaySummary();

  if (summary.dateKey !== getDateKey()) {
    await resetTodaySummary();
  }

  const state = await getRollingState();

  if (state.currentIdleState !== "active") {
    await recordIdleMinute();
  }

  await recalculateState({ forceFlush: true, forceSample: true });
}

chrome.runtime.onInstalled.addListener(() => {
  enqueueMutation(async () => {
    await ensureInitialized();
    chrome.idle.setDetectionInterval(60);
    const settings = await getSettings();

    if (!settings.firstRunCompleted) {
      await chrome.tabs.create({
        url: chrome.runtime.getURL("popup.html?view=welcome")
      });
    }
  }).catch((error) => {
    console.error("Cognitive Load Meter install failed", error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  enqueueMutation(async () => {
    await ensureInitialized();
    chrome.idle.setDetectionInterval(60);
    await recalculateState({ forceFlush: true, forceSample: true });
  }).catch((error) => {
    console.error("Cognitive Load Meter startup failed", error);
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) {
    return;
  }

  enqueueMutation(() => handleMaintenanceAlarm()).catch((error) => {
    console.error("Cognitive Load Meter maintenance failed", error);
  });
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  enqueueMutation(() => recordTabSwitch(activeInfo.tabId)).catch((error) => {
    console.error("Cognitive Load Meter tab tracking failed", error);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  enqueueMutation(async () => {
    const state = await getRollingState();
    delete state.focusModeTabs[String(tabId)];

    if (state.activeTabId === tabId) {
      state.activeTabId = null;
    }

    await chrome.storage.session.set({ [STORAGE_KEYS.rollingState]: state });
  }).catch((error) => {
    console.error("Cognitive Load Meter tab cleanup failed", error);
  });
});

chrome.idle.onStateChanged.addListener((newState) => {
  enqueueMutation(() => handleIdleStateChanged(newState)).catch((error) => {
    console.error("Cognitive Load Meter idle tracking failed", error);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    await ensureInitialized();

    if (message?.type === "GET_DASHBOARD_STATE") {
      const tabId = message.tabId ?? sender.tab?.id ?? (await getActiveTabId());
      sendResponse(await getDashboardState(tabId));
      return;
    }

    if (message?.type === "GET_LIVE_STATE") {
      const tabId = message.tabId ?? sender.tab?.id ?? (await getActiveTabId());
      const dashboardState = await getDashboardState(tabId);
      sendResponse(dashboardState.live);
      return;
    }

    if (message?.type === "CONTENT_SCROLL_SAMPLE") {
      await enqueueMutation(() => recordScrollSample(message.payload || {}));
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "TOGGLE_TRACKING") {
      const payload = await enqueueMutation(() => setTrackingEnabled(Boolean(message.enabled)));
      sendResponse(payload);
      return;
    }

    if (message?.type === "TOGGLE_FOCUS_MODE") {
      const tabId = message.tabId ?? sender.tab?.id ?? (await getActiveTabId());

      if (!tabId) {
        sendResponse({ ok: false });
        return;
      }

      const focusModeActive = await enqueueMutation(() => toggleFocusMode(tabId, message.enabled));
      sendResponse({ ok: true, focusModeActive });
      return;
    }

    if (message?.type === "INTERVENTION_SHOWN") {
      await enqueueMutation(() => acknowledgeIntervention("shown"));
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "DISMISS_INTERVENTION") {
      await enqueueMutation(() => acknowledgeIntervention("dismissed"));
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "START_BREAK_SESSION") {
      await enqueueMutation(() => startBreakSession());
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "SAVE_SETTINGS") {
      const settings = await enqueueMutation(() => saveSettings(message.settings || {}));
      sendResponse({ ok: true, settings });
      return;
    }

    if (message?.type === "SET_DEBUG_STATE") {
      await enqueueMutation(() => setDebugState(message.mode));
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "RESET_TODAY_SUMMARY") {
      await enqueueMutation(async () => {
        await resetTodaySummary();
        await recalculateState({ forceFlush: true, forceSample: true });
      });
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false });
  })().catch((error) => {
    console.error("Cognitive Load Meter background error", error);
    sendResponse({ ok: false, error: error.message });
  });

  return true;
});
