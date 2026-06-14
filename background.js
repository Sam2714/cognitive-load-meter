"use strict";

const STORAGE_KEYS = {
  settings: "settings",
  todaySummary: "todaySummary",
  rollingState: "rollingState",
  domainProfiles: "domainProfiles"
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

function createDefaultDomainProfile(domain = "") {
  return {
    domain,
    visits: 0,
    tabSwitches: 0,
    scrollBursts: 0,
    directionFlips: 0,
    recoveryMinutes: 0,
    focusModeUses: 0,
    breakSessions: 0,
    interventionsShown: 0,
    highEvents: 0,
    scoreTotal: 0,
    scoreSamples: 0,
    lastSeenAt: 0
  };
}

function createPendingDomainUpdate() {
  return {
    visits: 0,
    tabSwitches: 0,
    scrollBursts: 0,
    directionFlips: 0,
    recoveryMinutes: 0,
    focusModeUses: 0,
    breakSessions: 0,
    interventionsShown: 0,
    highEvents: 0,
    scoreTotal: 0,
    scoreSamples: 0,
    lastSeenAt: 0
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
    activeDomain: null,
    activeDomainContext: null,
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
    pendingSummary: createPendingSummary(),
    pendingDomainUpdates: {}
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

function normalizeDomain(domain) {
  if (typeof domain !== "string") {
    return null;
  }

  const trimmed = domain.trim().toLowerCase().replace(/^www\./, "");
  return trimmed || null;
}

function domainFromUrl(url) {
  if (typeof url !== "string" || !url) {
    return null;
  }

  try {
    const parsed = new URL(url);

    if (!/^https?:$/.test(parsed.protocol)) {
      return null;
    }

    return normalizeDomain(parsed.hostname);
  } catch (error) {
    return null;
  }
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

function normalizeDomainProfile(domain, profile) {
  const base = createDefaultDomainProfile(domain);

  return {
    ...base,
    ...(profile || {}),
    domain,
    visits: Number(profile?.visits || 0),
    tabSwitches: Number(profile?.tabSwitches || 0),
    scrollBursts: Number(profile?.scrollBursts || 0),
    directionFlips: Number(profile?.directionFlips || 0),
    recoveryMinutes: Number(profile?.recoveryMinutes || 0),
    focusModeUses: Number(profile?.focusModeUses || 0),
    breakSessions: Number(profile?.breakSessions || 0),
    interventionsShown: Number(profile?.interventionsShown || 0),
    highEvents: Number(profile?.highEvents || 0),
    scoreTotal: Number(profile?.scoreTotal || 0),
    scoreSamples: Number(profile?.scoreSamples || 0),
    lastSeenAt: Number(profile?.lastSeenAt || 0)
  };
}

function normalizePendingDomainUpdates(updates) {
  if (!updates || typeof updates !== "object") {
    return {};
  }

  return Object.entries(updates).reduce((accumulator, [domain, update]) => {
    const normalizedDomain = normalizeDomain(domain);

    if (!normalizedDomain) {
      return accumulator;
    }

    accumulator[normalizedDomain] = {
      ...createPendingDomainUpdate(),
      ...update,
      visits: Number(update?.visits || 0),
      tabSwitches: Number(update?.tabSwitches || 0),
      scrollBursts: Number(update?.scrollBursts || 0),
      directionFlips: Number(update?.directionFlips || 0),
      recoveryMinutes: Number(update?.recoveryMinutes || 0),
      focusModeUses: Number(update?.focusModeUses || 0),
      breakSessions: Number(update?.breakSessions || 0),
      interventionsShown: Number(update?.interventionsShown || 0),
      highEvents: Number(update?.highEvents || 0),
      scoreTotal: Number(update?.scoreTotal || 0),
      scoreSamples: Number(update?.scoreSamples || 0),
      lastSeenAt: Number(update?.lastSeenAt || 0)
    };

    return accumulator;
  }, {});
}

function normalizeDomainProfiles(profiles) {
  if (!profiles || typeof profiles !== "object") {
    return {};
  }

  return Object.entries(profiles).reduce((accumulator, [domain, profile]) => {
    const normalizedDomain = normalizeDomain(domain);

    if (!normalizedDomain) {
      return accumulator;
    }

    accumulator[normalizedDomain] = normalizeDomainProfile(normalizedDomain, profile);
    return accumulator;
  }, {});
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

function sanitizeDomainContext(context) {
  if (!context || typeof context !== "object") {
    return null;
  }

  const domain = normalizeDomain(context.domain);

  if (!domain) {
    return null;
  }

  return {
    domain,
    label: typeof context.label === "string" ? context.label : domain,
    averageScore: Number(context.averageScore || 0),
    visits: Number(context.visits || 0),
    highEvents: Number(context.highEvents || 0),
    adjustment: Number(context.adjustment || 0),
    tendency: typeof context.tendency === "string" ? context.tendency : "neutral",
    confidence: Number(context.confidence || 0),
    confidenceLabel: typeof context.confidenceLabel === "string" ? context.confidenceLabel : "light"
  };
}

function normalizeRollingState(state) {
  const base = createDefaultRollingState();

  return {
    ...base,
    ...state,
    tabSwitchEvents: Array.isArray(state?.tabSwitchEvents)
      ? state.tabSwitchEvents
          .map((value) => {
            if (Number.isFinite(value)) {
              return {
                timestamp: Number(value),
                domain: null
              };
            }

            if (!value || !Number.isFinite(value.timestamp)) {
              return null;
            }

            return {
              timestamp: Number(value.timestamp),
              domain: normalizeDomain(value.domain)
            };
          })
          .filter(Boolean)
      : [],
    scrollEvents: Array.isArray(state?.scrollEvents)
      ? state.scrollEvents
          .filter((event) => event && Number.isFinite(event.timestamp))
          .map((event) => ({
            timestamp: Number(event.timestamp),
            burst: Boolean(event.burst),
            flips: Number(event.flips || 0),
            velocity: Number(event.velocity || 0),
            domain: normalizeDomain(event.domain)
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
    activeDomain: normalizeDomain(state?.activeDomain),
    activeDomainContext: sanitizeDomainContext(state?.activeDomainContext),
    focusModeTabs: typeof state?.focusModeTabs === "object" && state?.focusModeTabs ? state.focusModeTabs : {},
    pendingSummary: normalizePendingSummary(state?.pendingSummary),
    pendingDomainUpdates: normalizePendingDomainUpdates(state?.pendingDomainUpdates)
  };
}

function mergeDomainMetric(target, source) {
  target.visits += Number(source?.visits || 0);
  target.tabSwitches += Number(source?.tabSwitches || 0);
  target.scrollBursts += Number(source?.scrollBursts || 0);
  target.directionFlips += Number(source?.directionFlips || 0);
  target.recoveryMinutes += Number(source?.recoveryMinutes || 0);
  target.focusModeUses += Number(source?.focusModeUses || 0);
  target.breakSessions += Number(source?.breakSessions || 0);
  target.interventionsShown += Number(source?.interventionsShown || 0);
  target.highEvents += Number(source?.highEvents || 0);
  target.scoreTotal += Number(source?.scoreTotal || 0);
  target.scoreSamples += Number(source?.scoreSamples || 0);
  target.lastSeenAt = Math.max(Number(target.lastSeenAt || 0), Number(source?.lastSeenAt || 0));
}

function ensurePendingDomainUpdate(state, domain) {
  const normalizedDomain = normalizeDomain(domain);

  if (!normalizedDomain) {
    return null;
  }

  if (!state.pendingDomainUpdates[normalizedDomain]) {
    state.pendingDomainUpdates[normalizedDomain] = createPendingDomainUpdate();
  }

  return state.pendingDomainUpdates[normalizedDomain];
}

function recordPendingDomainMetric(state, domain, metrics) {
  const pendingUpdate = ensurePendingDomainUpdate(state, domain);

  if (!pendingUpdate) {
    return;
  }

  mergeDomainMetric(pendingUpdate, metrics);
}

function buildMergedDomainProfile(domain, domainProfiles, pendingUpdates) {
  const normalizedDomain = normalizeDomain(domain);

  if (!normalizedDomain) {
    return null;
  }

  const mergedProfile = normalizeDomainProfile(normalizedDomain, domainProfiles?.[normalizedDomain]);
  mergeDomainMetric(mergedProfile, pendingUpdates?.[normalizedDomain]);
  return mergedProfile;
}

function computeDomainContext(domain, domainProfiles, pendingUpdates) {
  const mergedProfile = buildMergedDomainProfile(domain, domainProfiles, pendingUpdates);

  if (!mergedProfile) {
    return null;
  }

  const averageScore = mergedProfile.scoreSamples > 0 ? mergedProfile.scoreTotal / mergedProfile.scoreSamples : 0;
  const evidencePoints = mergedProfile.visits + mergedProfile.scoreSamples * 0.5;
  const confidence = clamp(evidencePoints / 10, 0, 1);
  const highRate = mergedProfile.visits > 0 ? mergedProfile.highEvents / mergedProfile.visits : 0;
  const burstRate = mergedProfile.visits > 0 ? mergedProfile.scrollBursts / mergedProfile.visits : 0;
  const recoveryRate = mergedProfile.visits > 0 ? mergedProfile.recoveryMinutes / mergedProfile.visits : 0;
  const adaptiveBase =
    clamp((averageScore - 50) / 7, -4, 6) +
    clamp(highRate * 8, 0, 6) +
    clamp(burstRate * 1.5, 0, 3) -
    clamp(recoveryRate * 0.7, 0, 4);
  const adjustment = evidencePoints < 2 ? 0 : Math.round(clamp(adaptiveBase * confidence, -6, 10));

  return {
    domain: mergedProfile.domain,
    label: mergedProfile.domain,
    averageScore: Math.round(averageScore),
    visits: mergedProfile.visits,
    highEvents: mergedProfile.highEvents,
    adjustment,
    tendency: adjustment >= 3 ? "heavy" : adjustment <= -2 ? "calm" : "neutral",
    confidence: Math.round(confidence * 100),
    confidenceLabel: confidence >= 0.75 ? "strong" : confidence >= 0.35 ? "building" : "light"
  };
}

function hasPendingDomainUpdates(updates) {
  return Object.values(updates || {}).some((update) =>
    Object.entries(update || {}).some(([key, value]) => key !== "lastSeenAt" && Number(value || 0) > 0)
  );
}

function pruneDomainProfiles(profiles, limit = 60) {
  const entries = Object.entries(profiles || {});

  if (entries.length <= limit) {
    return profiles;
  }

  return entries
    .sort((left, right) => Number(right[1]?.lastSeenAt || 0) - Number(left[1]?.lastSeenAt || 0))
    .slice(0, limit)
    .reduce((accumulator, [domain, profile]) => {
      accumulator[domain] = profile;
      return accumulator;
    }, {});
}

function countSignals(state, options = {}) {
  const domain = normalizeDomain(options.domain);
  const filterByDomain = Boolean(domain);
  const tabSwitchEvents = filterByDomain
    ? state.tabSwitchEvents.filter((event) => event.domain === domain)
    : state.tabSwitchEvents;
  const scrollEvents = filterByDomain
    ? state.scrollEvents.filter((event) => event.domain === domain)
    : state.scrollEvents;

  return {
    switches10m: tabSwitchEvents.length,
    bursts5m: scrollEvents.reduce((total, event) => total + (event.burst ? 1 : 0), 0),
    flips5m: scrollEvents.reduce((total, event) => total + Number(event.flips || 0), 0),
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
  state.tabSwitchEvents = state.tabSwitchEvents.filter((event) => now - event.timestamp <= TAB_WINDOW_MS);
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
        chrome.storage.local.get([STORAGE_KEYS.settings, STORAGE_KEYS.todaySummary, STORAGE_KEYS.domainProfiles]),
        chrome.storage.session.get(STORAGE_KEYS.rollingState)
      ]);

      const localUpdates = {};
      const sessionUpdates = {};
      const todayKey = getDateKey();
      const settings = sanitizeSettings(localStore[STORAGE_KEYS.settings]);
      const summary = normalizeTodaySummary(localStore[STORAGE_KEYS.todaySummary]);
      const domainProfiles = normalizeDomainProfiles(localStore[STORAGE_KEYS.domainProfiles]);
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

      if (!localStore[STORAGE_KEYS.domainProfiles]) {
        localUpdates[STORAGE_KEYS.domainProfiles] = domainProfiles;
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

async function getDomainProfiles() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.domainProfiles);
  return normalizeDomainProfiles(result[STORAGE_KEYS.domainProfiles]);
}

async function getLastFocusedActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs[0] ?? null;
}

async function getActiveTabId() {
  const tab = await getLastFocusedActiveTab();
  return tab?.id ?? null;
}

async function resolveDomainForTab(tabId) {
  if (typeof tabId !== "number") {
    return null;
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    return domainFromUrl(tab?.url);
  } catch (error) {
    return null;
  }
}

async function ensureActiveContext(state) {
  const previousActiveTabId = state.activeTabId;
  let activeTab = null;

  if (typeof state.activeTabId === "number") {
    try {
      activeTab = await chrome.tabs.get(state.activeTabId);
    } catch (error) {
      activeTab = null;
    }
  }

  if (!activeTab) {
    activeTab = await getLastFocusedActiveTab();
  }

  const activeTabId = activeTab?.id ?? null;

  if (!activeTabId) {
    state.activeTabId = null;
    state.activeDomain = null;
    state.activeDomainContext = null;
    return state;
  }

  if (activeTabId !== state.activeTabId) {
    state.activeTabId = activeTabId;
  }

  const resolvedDomain = domainFromUrl(activeTab?.url);

  if (activeTabId !== previousActiveTabId || resolvedDomain !== state.activeDomain) {
    state.activeDomain = resolvedDomain;
    state.activeDomainContext = null;
  }

  return state;
}

function syncActiveDomainContext(state, domainProfiles) {
  state.activeDomainContext = computeDomainContext(state.activeDomain, domainProfiles, state.pendingDomainUpdates);
  return state;
}

async function flushPendingSummary(state, options = {}) {
  const now = options.now || Date.now();
  const force = Boolean(options.force);
  const domainProfiles = normalizeDomainProfiles(options.domainProfiles);

  if (!force && now - state.lastSummaryWriteAt < SUMMARY_FLUSH_INTERVAL_MS) {
    await chrome.storage.session.set({ [STORAGE_KEYS.rollingState]: state });
    return;
  }

  if (!hasPendingSummary(state.pendingSummary) && !hasPendingDomainUpdates(state.pendingDomainUpdates)) {
    state.lastSummaryWriteAt = now;
    await chrome.storage.session.set({ [STORAGE_KEYS.rollingState]: state });
    return;
  }

  const summary = await getTodaySummary();
  const pendingSummary = normalizePendingSummary(state.pendingSummary);
  const nextDomainProfiles = domainProfiles && Object.keys(domainProfiles).length > 0 ? domainProfiles : await getDomainProfiles();

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

  Object.entries(normalizePendingDomainUpdates(state.pendingDomainUpdates)).forEach(([domain, pendingUpdate]) => {
    const profile = normalizeDomainProfile(domain, nextDomainProfiles[domain]);
    mergeDomainMetric(profile, pendingUpdate);
    nextDomainProfiles[domain] = profile;
  });

  state.pendingSummary = createPendingSummary();
  state.pendingDomainUpdates = {};
  state.lastSummaryWriteAt = now;

  await Promise.all([
    chrome.storage.local.set({
      [STORAGE_KEYS.todaySummary]: summary,
      [STORAGE_KEYS.domainProfiles]: pruneDomainProfiles(nextDomainProfiles)
    }),
    chrome.storage.session.set({ [STORAGE_KEYS.rollingState]: state })
  ]);
}

function computeScore(state, domainContext) {
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
  const domainPressure = Number(domainContext?.adjustment || 0);
  const rawScore = clamp(tabPressure + scrollPressure + domainPressure - idleRelief, 0, 100);
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

async function buildLiveStatePayload(state, settings, domainProfiles, tabReference) {
  let tab = null;

  if (typeof tabReference === "number") {
    try {
      tab = await chrome.tabs.get(tabReference);
    } catch (error) {
      tab = { id: tabReference };
    }
  } else if (tabReference && typeof tabReference === "object") {
    tab = tabReference;
  }

  const resolvedTabId = typeof tab?.id === "number" ? tab.id : tabReference ?? state.activeTabId;
  const focusModeActive = Boolean(resolvedTabId && state.focusModeTabs[String(resolvedTabId)]);
  const trackingActive = isTrackingActive(settings, state);
  const isPrimaryTab = typeof resolvedTabId === "number" && resolvedTabId === state.activeTabId;
  const tabDomain = isPrimaryTab ? state.activeDomain : domainFromUrl(tab?.url);
  const sessionSignals = countSignals(state);
  const surfaceSignals = tabDomain ? countSignals(state, { domain: tabDomain }) : sessionSignals;
  const currentDomainProfile = !trackingActive
    ? null
    : isPrimaryTab
      ? state.activeDomainContext
      : computeDomainContext(tabDomain, domainProfiles, state.pendingDomainUpdates);

  return {
    score: trackingActive ? state.currentScore : 0,
    status: trackingActive ? state.currentStatus : "Low",
    trackingEnabled: trackingActive,
    interventionEligible: isPrimaryTab && isInterventionEligible(state, settings),
    focusModeActive,
    isPrimaryTab,
    activeTabId: state.activeTabId,
    surfaceTabId: resolvedTabId,
    lastInterventionAt: state.lastInterventionAt,
    recentScores: state.recentScores,
    sessionStartedAt: state.sessionStartedAt,
    signalCounts: sessionSignals,
    surfaceSignalCounts: surfaceSignals,
    currentDomainProfile,
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
  const domainProfiles = preloaded?.domainProfiles || (await getDomainProfiles());
  const state = syncActiveDomainContext(
    await ensureActiveContext(preloaded?.state || (await getRollingState())),
    domainProfiles
  );
  const activeTabId = state.activeTabId ?? (await getActiveTabId());
  const activePayload = await buildLiveStatePayload(state, settings, domainProfiles, activeTabId);

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
      .map(async (tab) =>
        chrome.tabs.sendMessage(tab.id, {
          type: "LIVE_STATE_UPDATED",
          payload: await buildLiveStatePayload(state, settings, domainProfiles, tab)
        }).catch(() => undefined)
      )
  );
}

async function getDashboardState(tabId) {
  await ensureInitialized();
  const [settings, summary, initialState, domainProfiles] = await Promise.all([
    getSettings(),
    getTodaySummary(),
    getRollingState(),
    getDomainProfiles()
  ]);
  const state = syncActiveDomainContext(await ensureActiveContext(initialState), domainProfiles);
  await chrome.storage.session.set({ [STORAGE_KEYS.rollingState]: state });

  return {
    settings,
    summary,
    live: await buildLiveStatePayload(state, settings, domainProfiles, tabId)
  };
}

async function recalculateState(options = {}) {
  await ensureInitialized();

  const now = options.now || Date.now();
  const [settings, initialState, domainProfiles] = await Promise.all([getSettings(), getRollingState(), getDomainProfiles()]);
  const state = syncActiveDomainContext(await ensureActiveContext(normalizeRollingState(initialState)), domainProfiles);
  const previousStatus = state.currentStatus;

  trimRollingState(state, now);

  if (!settings.trackingEnabled && !state.debugOverride) {
    state.currentScore = 0;
    state.currentStatus = "Low";
    state.suppressedWhileHigh = false;
    state.suppressionUntil = 0;
  } else {
    const computed = computeScore(state, state.activeDomainContext);
    state.currentScore = computed.score;
    state.currentStatus = computed.status;
  }

  if (state.currentScore < Math.max(0, settings.interventionThreshold - 15)) {
    state.suppressedWhileHigh = false;
    state.suppressionUntil = 0;
  }

  if (shouldTrackScores(settings, state)) {
    addHourlyScoreSample(state.pendingSummary, state.currentScore, now);
    recordPendingDomainMetric(state, state.activeDomain, {
      scoreTotal: state.currentScore,
      scoreSamples: 1,
      lastSeenAt: now
    });

    if (previousStatus !== "High" && state.currentStatus === "High") {
      addHourlyHighEntry(state.pendingSummary, now);
      recordPendingDomainMetric(state, state.activeDomain, {
        highEvents: 1,
        lastSeenAt: now
      });
    }

    sampleRecentScore(state, now, previousStatus, Boolean(options.forceSample));
  }

  await flushPendingSummary(state, {
    now,
    domainProfiles,
    force: Boolean(options.forceFlush) || previousStatus !== state.currentStatus
  });

  await broadcastLiveState({ settings, state, domainProfiles });
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
    const [state, domainProfiles] = await Promise.all([getRollingState(), getDomainProfiles()]);
    return buildLiveStatePayload(state, settings, domainProfiles, currentState.activeTabId);
  }

  const resetState = createDefaultRollingState();
  resetState.activeTabId = currentState.activeTabId;
  resetState.activeDomain = currentState.activeDomain;

  await Promise.all([
    chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings }),
    chrome.storage.session.set({ [STORAGE_KEYS.rollingState]: resetState })
  ]);

  await broadcastLiveState({ settings, state: resetState });
  return buildLiveStatePayload(resetState, settings, await getDomainProfiles(), currentState.activeTabId);
}

async function recordTabSwitch(tabId) {
  await ensureInitialized();
  const settings = await getSettings();

  if (!settings.trackingEnabled) {
    return;
  }

  const now = Date.now();
  const state = await getRollingState();
  const nextDomain = await resolveDomainForTab(tabId);
  const isInitialActivation = state.activeTabId === null && state.lastTabSwitchAt === 0;

  if (tabId === state.activeTabId && nextDomain === state.activeDomain) {
    return;
  }

  const previousDomain = state.activeDomain;
  state.activeTabId = tabId;
  state.activeDomain = nextDomain;

  if (nextDomain && nextDomain !== previousDomain) {
    recordPendingDomainMetric(state, nextDomain, {
      visits: 1,
      lastSeenAt: now
    });
  }

  if (isInitialActivation) {
    await chrome.storage.session.set({ [STORAGE_KEYS.rollingState]: state });
    await broadcastLiveState({ settings, state });
    return;
  }

  if (now - state.lastTabSwitchAt < TAB_SWITCH_COOLDOWN_MS) {
    await chrome.storage.session.set({ [STORAGE_KEYS.rollingState]: state });
    await broadcastLiveState({ settings, state });
    return;
  }

  state.lastTabSwitchAt = now;
  state.tabSwitchEvents.push({
    timestamp: now,
    domain: nextDomain
  });
  state.pendingSummary.tabSwitches += 1;
  recordPendingDomainMetric(state, nextDomain, {
    tabSwitches: 1,
    lastSeenAt: now
  });

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
  const sourceDomain = normalizeDomain(sample.domain) || state.activeDomain;

  state.scrollEvents.push({
    timestamp: Number(sample.timestamp || Date.now()),
    burst: Boolean(sample.burst),
    flips: Number(sample.directionChanges > 3 ? sample.directionChanges : 0),
    velocity: Number(sample.velocity || 0),
    domain: sourceDomain
  });

  if (sample.burst) {
    state.pendingSummary.scrollBursts += 1;
  }

  if (sample.directionChanges > 3) {
    state.pendingSummary.directionFlips += Number(sample.directionChanges);
  }

  recordPendingDomainMetric(state, sourceDomain, {
    scrollBursts: sample.burst ? 1 : 0,
    directionFlips: sample.directionChanges > 3 ? Number(sample.directionChanges) : 0,
    lastSeenAt: Number(sample.timestamp || Date.now())
  });

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
  recordPendingDomainMetric(state, state.activeDomain, {
    recoveryMinutes: 1,
    lastSeenAt: now
  });

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

async function acknowledgeIntervention(kind, tabId) {
  const [settings, domainProfiles, initialState] = await Promise.all([
    getSettings(),
    getDomainProfiles(),
    getRollingState()
  ]);
  const state = syncActiveDomainContext(await ensureActiveContext(initialState), domainProfiles);
  const now = Date.now();
  const sourceTabId = typeof tabId === "number" ? tabId : state.activeTabId;

  if (sourceTabId && state.activeTabId && sourceTabId !== state.activeTabId) {
    await broadcastLiveState({ settings, state, domainProfiles });
    return false;
  }

  const sourceDomain = sourceTabId ? await resolveDomainForTab(sourceTabId) : state.activeDomain;

  if (kind === "shown") {
    state.pendingSummary.interventionsShown += 1;
    recordPendingDomainMetric(state, sourceDomain, {
      interventionsShown: 1,
      lastSeenAt: now
    });
  }

  if (sourceTabId === state.activeTabId && sourceDomain !== state.activeDomain) {
    state.activeDomain = sourceDomain;
    syncActiveDomainContext(state, domainProfiles);
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

  await flushPendingSummary(state, {
    force: kind === "shown",
    domainProfiles
  });
  await broadcastLiveState({ settings, state, domainProfiles });
  return true;
}

async function startBreakSession(tabId) {
  const [settings, domainProfiles, initialState] = await Promise.all([
    getSettings(),
    getDomainProfiles(),
    getRollingState()
  ]);
  const state = syncActiveDomainContext(await ensureActiveContext(initialState), domainProfiles);
  const sourceTabId = typeof tabId === "number" ? tabId : state.activeTabId;

  if (sourceTabId && state.activeTabId && sourceTabId !== state.activeTabId) {
    await broadcastLiveState({ settings, state, domainProfiles });
    return false;
  }

  const sourceDomain = sourceTabId ? await resolveDomainForTab(sourceTabId) : state.activeDomain;
  state.pendingSummary.breakSessions += 1;
  recordPendingDomainMetric(state, sourceDomain, {
    breakSessions: 1,
    lastSeenAt: Date.now()
  });

  if (sourceTabId === state.activeTabId && sourceDomain !== state.activeDomain) {
    state.activeDomain = sourceDomain;
    syncActiveDomainContext(state, domainProfiles);
  }

  await flushPendingSummary(state, {
    force: true,
    domainProfiles
  });
  await broadcastLiveState({ settings, state, domainProfiles });
  return true;
}

async function toggleFocusMode(tabId, enabled) {
  const [settings, domainProfiles, initialState] = await Promise.all([
    getSettings(),
    getDomainProfiles(),
    getRollingState()
  ]);
  const state = syncActiveDomainContext(await ensureActiveContext(initialState), domainProfiles);
  const key = String(tabId);
  const nextValue = typeof enabled === "boolean" ? enabled : !state.focusModeTabs[key];
  const targetDomain = tabId === state.activeTabId ? state.activeDomain : await resolveDomainForTab(tabId);

  if (nextValue) {
    state.focusModeTabs[key] = true;
    state.pendingSummary.focusModeUses += 1;
    recordPendingDomainMetric(state, targetDomain, {
      focusModeUses: 1,
      lastSeenAt: Date.now()
    });
  } else {
    delete state.focusModeTabs[key];
  }

  await flushPendingSummary(state, {
    force: true,
    domainProfiles
  });
  await broadcastLiveState({ settings, state, domainProfiles });

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
  state.pendingDomainUpdates = {};
  state.lastSummaryWriteAt = 0;
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

async function handleTabUpdated(tabId, changeInfo, tab) {
  if (!changeInfo.url && !tab?.url) {
    return;
  }

  await ensureInitialized();
  const [settings, domainProfiles, initialState] = await Promise.all([
    getSettings(),
    getDomainProfiles(),
    getRollingState()
  ]);
  const state = syncActiveDomainContext(await ensureActiveContext(initialState), domainProfiles);
  const nextDomain = domainFromUrl(changeInfo.url || tab?.url);

  if (tabId !== state.activeTabId) {
    if (String(tabId) in state.focusModeTabs) {
      await broadcastLiveState({ settings, state, domainProfiles });
    }

    return;
  }

  if (nextDomain === state.activeDomain) {
    return;
  }

  state.activeTabId = tabId;
  state.activeDomain = nextDomain;
  state.activeDomainContext = null;

  if (settings.trackingEnabled && nextDomain) {
    recordPendingDomainMetric(state, nextDomain, {
      visits: 1,
      lastSeenAt: Date.now()
    });
  }

  await chrome.storage.session.set({ [STORAGE_KEYS.rollingState]: state });

  if (settings.trackingEnabled) {
    await recalculateState({ forceFlush: true, forceSample: true });
    return;
  }

  await broadcastLiveState({ settings, state, domainProfiles });
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

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== "complete") {
    return;
  }

  enqueueMutation(() => handleTabUpdated(tabId, changeInfo, tab)).catch((error) => {
    console.error("Cognitive Load Meter tab update handling failed", error);
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
      await enqueueMutation(() =>
        recordScrollSample({
          ...(message.payload || {}),
          domain: domainFromUrl(sender.tab?.url)
        })
      );
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
      const acknowledged = await enqueueMutation(() => acknowledgeIntervention("shown", sender.tab?.id));
      sendResponse({ ok: acknowledged });
      return;
    }

    if (message?.type === "DISMISS_INTERVENTION") {
      const acknowledged = await enqueueMutation(() => acknowledgeIntervention("dismissed", sender.tab?.id));
      sendResponse({ ok: acknowledged });
      return;
    }

    if (message?.type === "START_BREAK_SESSION") {
      const started = await enqueueMutation(() => startBreakSession(sender.tab?.id));
      sendResponse({ ok: started });
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
