"use strict";

(function cognitiveLoadMeterContent() {
  if (window.top !== window.self) {
    return;
  }

  const blockedProtocols = ["chrome:", "edge:", "about:", "moz-extension:"];
  const blockedHostFragments = ["chrome.google.com/webstore", "chromewebstore.google.com"];

  if (
    blockedProtocols.includes(window.location.protocol) ||
    blockedHostFragments.some((fragment) => window.location.href.includes(fragment)) ||
    window.location.pathname.toLowerCase().endsWith(".pdf") ||
    !document.documentElement ||
    !document.body
  ) {
    return;
  }

  const state = {
    trackingEnabled: false,
    rootMounted: false,
    focusListenersAttached: false,
    panelVisible: false,
    suggestionVisible: false,
    breakOverlayVisible: false,
    scrollListener: null,
    scrollWindow: null,
    scrollTimeoutId: null,
    rafScheduled: false,
    highlightFrame: null,
    breakTimerId: null,
    breakSecondsRemaining: 0,
    host: null,
    shadow: null,
    stack: null,
    widget: null,
    widgetScore: null,
    widgetStatus: null,
    panel: null,
    panelTitle: null,
    panelBody: null,
    panelScore: null,
    panelSignals: null,
    panelFocusButton: null,
    panelBreakButton: null,
    panelSnoozeButton: null,
    card: null,
    cardTitle: null,
    cardBody: null,
    cardSecondary: null,
    focusVeil: null,
    focusHighlight: null,
    breakOverlay: null,
    breakTimerLabel: null,
    breakTitle: null,
    breakSubtext: null,
    live: {
      score: 0,
      status: "Low",
      trackingEnabled: false,
      interventionEligible: false,
      focusModeActive: false,
      signalCounts: {
        switches10m: 0,
        bursts5m: 0,
        flips5m: 0,
        idleMinutes10m: 0
      },
      uiPreferences: {
        suggestionsEnabled: true,
        interventionThreshold: 70,
        breakDurationSeconds: 60,
        indicatorPosition: "bottom-right",
        focusOverlayStrength: 24
      }
    }
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

  function statusDescription(status) {
    if (status === "High") {
      return "Your pace looks dense right now. A quick reset may help.";
    }

    if (status === "Medium") {
      return "Some friction is building. Staying on one thread may help.";
    }

    return "Your browsing rhythm looks steady and manageable.";
  }

  function ensureUi() {
    if (state.rootMounted) {
      return;
    }

    state.host = document.createElement("div");
    state.host.style.all = "initial";
    state.host.style.position = "fixed";
    state.host.style.inset = "0";
    state.host.style.zIndex = "2147483646";
    state.host.style.pointerEvents = "none";

    state.shadow = state.host.attachShadow({ mode: "open" });

    const styleLink = document.createElement("link");
    styleLink.rel = "stylesheet";
    styleLink.href = chrome.runtime.getURL("style.css");

    const wrapper = document.createElement("div");
    wrapper.className = "clm-root";
    wrapper.innerHTML = `
      <div class="clm-focus-veil" hidden></div>
      <div class="clm-focus-highlight" hidden></div>
      <div class="clm-break-overlay" hidden>
        <div class="clm-break-sheet">
          <p class="clm-card-kicker">Quick Reset</p>
          <h3 class="clm-break-title">Take a quiet minute</h3>
          <p class="clm-break-subtext">Look away from the screen, loosen your shoulders, and slow your breathing.</p>
          <div class="clm-break-timer">01:00</div>
          <div class="clm-break-actions">
            <button class="clm-button clm-button-primary" data-break-action="finish" type="button">Resume</button>
            <button class="clm-button clm-button-ghost" data-break-action="skip" type="button">End early</button>
          </div>
        </div>
      </div>
      <div class="clm-stack" data-position="bottom-right">
        <button class="clm-widget" type="button" aria-label="Cognitive Load Meter">
          <span class="clm-widget-ring"></span>
          <span class="clm-widget-score">0</span>
          <span class="clm-widget-status">Low</span>
        </button>
        <section class="clm-panel" hidden>
          <div class="clm-panel-header">
            <div>
              <p class="clm-card-kicker">Live Snapshot</p>
              <h3 class="clm-panel-title">Low load</h3>
            </div>
            <div class="clm-panel-score">0</div>
          </div>
          <p class="clm-panel-body">Your browsing rhythm looks steady and manageable.</p>
          <div class="clm-panel-signals">
            <div class="clm-panel-signal">
              <span>Switches</span>
              <strong data-signal="switches">0</strong>
            </div>
            <div class="clm-panel-signal">
              <span>Scan bursts</span>
              <strong data-signal="bursts">0</strong>
            </div>
            <div class="clm-panel-signal">
              <span>Recovery</span>
              <strong data-signal="idle">0m</strong>
            </div>
          </div>
          <div class="clm-panel-actions">
            <button class="clm-button clm-button-secondary" data-panel-action="focus" type="button">Focus mode</button>
            <button class="clm-button clm-button-primary" data-panel-action="break" type="button">Quick reset</button>
            <button class="clm-button clm-button-ghost" data-panel-action="snooze" type="button">Snooze</button>
          </div>
        </section>
        <section class="clm-card" hidden>
          <div class="clm-card-copy">
            <p class="clm-card-kicker">Gentle Intervention</p>
            <h3 class="clm-card-title">Take a lighter pace</h3>
            <p class="clm-card-body">Your recent patterns suggest a higher cognitive load right now.</p>
            <p class="clm-card-secondary">A short reset or a simpler reading view can lower friction quickly.</p>
          </div>
          <div class="clm-card-actions">
            <button class="clm-button clm-button-secondary" data-card-action="break" type="button">Take a break</button>
            <button class="clm-button clm-button-primary" data-card-action="focus" type="button">Simplify content</button>
            <button class="clm-button clm-button-ghost" data-card-action="dismiss" type="button">Dismiss</button>
          </div>
        </section>
      </div>
    `;

    state.shadow.append(styleLink, wrapper);
    document.documentElement.appendChild(state.host);

    state.stack = wrapper.querySelector(".clm-stack");
    state.widget = wrapper.querySelector(".clm-widget");
    state.widgetScore = wrapper.querySelector(".clm-widget-score");
    state.widgetStatus = wrapper.querySelector(".clm-widget-status");
    state.panel = wrapper.querySelector(".clm-panel");
    state.panelTitle = wrapper.querySelector(".clm-panel-title");
    state.panelBody = wrapper.querySelector(".clm-panel-body");
    state.panelScore = wrapper.querySelector(".clm-panel-score");
    state.panelSignals = wrapper.querySelector(".clm-panel-signals");
    state.panelFocusButton = wrapper.querySelector('[data-panel-action="focus"]');
    state.panelBreakButton = wrapper.querySelector('[data-panel-action="break"]');
    state.panelSnoozeButton = wrapper.querySelector('[data-panel-action="snooze"]');
    state.card = wrapper.querySelector(".clm-card");
    state.cardTitle = wrapper.querySelector(".clm-card-title");
    state.cardBody = wrapper.querySelector(".clm-card-body");
    state.cardSecondary = wrapper.querySelector(".clm-card-secondary");
    state.focusVeil = wrapper.querySelector(".clm-focus-veil");
    state.focusHighlight = wrapper.querySelector(".clm-focus-highlight");
    state.breakOverlay = wrapper.querySelector(".clm-break-overlay");
    state.breakTimerLabel = wrapper.querySelector(".clm-break-timer");
    state.breakTitle = wrapper.querySelector(".clm-break-title");
    state.breakSubtext = wrapper.querySelector(".clm-break-subtext");

    state.widget.addEventListener("click", () => {
      if (!state.trackingEnabled) {
        return;
      }

      setPanelVisibility(!state.panelVisible);
    });

    state.panel.addEventListener("click", async (event) => {
      const action = event.target.closest("[data-panel-action]")?.dataset.panelAction;

      if (!action) {
        return;
      }

      if (action === "focus") {
        await chrome.runtime.sendMessage({
          type: "TOGGLE_FOCUS_MODE",
          enabled: !state.live.focusModeActive
        }).catch(() => undefined);
        return;
      }

      if (action === "break") {
        await chrome.runtime.sendMessage({ type: "START_BREAK_SESSION" }).catch(() => undefined);
        startBreakOverlay();
        return;
      }

      if (action === "snooze") {
        await chrome.runtime.sendMessage({ type: "DISMISS_INTERVENTION" }).catch(() => undefined);
        hideSuggestion();
      }
    });

    state.card.addEventListener("click", async (event) => {
      const action = event.target.closest("[data-card-action]")?.dataset.cardAction;

      if (!action) {
        return;
      }

      if (action === "break") {
        await chrome.runtime.sendMessage({ type: "START_BREAK_SESSION" }).catch(() => undefined);
        await chrome.runtime.sendMessage({ type: "DISMISS_INTERVENTION" }).catch(() => undefined);
        startBreakOverlay();
        return;
      }

      if (action === "focus") {
        await chrome.runtime.sendMessage({
          type: "TOGGLE_FOCUS_MODE",
          enabled: !state.live.focusModeActive
        }).catch(() => undefined);
        return;
      }

      if (action === "dismiss") {
        await chrome.runtime.sendMessage({ type: "DISMISS_INTERVENTION" }).catch(() => undefined);
        hideSuggestion();
      }
    });

    state.breakOverlay.addEventListener("click", (event) => {
      const action = event.target.closest("[data-break-action]")?.dataset.breakAction;

      if (!action) {
        return;
      }

      if (action === "finish" || action === "skip") {
        stopBreakOverlay();
      }
    });

    state.rootMounted = true;
  }

  function teardownUi() {
    stopScrollSampling();
    stopBreakOverlay();
    removeFocusMode();

    if (state.host?.isConnected) {
      state.host.remove();
    }

    state.rootMounted = false;
    state.panelVisible = false;
    state.suggestionVisible = false;
    state.breakOverlayVisible = false;
    state.host = null;
    state.shadow = null;
    state.stack = null;
    state.widget = null;
    state.widgetScore = null;
    state.widgetStatus = null;
    state.panel = null;
    state.panelTitle = null;
    state.panelBody = null;
    state.panelScore = null;
    state.panelSignals = null;
    state.panelFocusButton = null;
    state.panelBreakButton = null;
    state.panelSnoozeButton = null;
    state.card = null;
    state.cardTitle = null;
    state.cardBody = null;
    state.cardSecondary = null;
    state.focusVeil = null;
    state.focusHighlight = null;
    state.breakOverlay = null;
    state.breakTimerLabel = null;
    state.breakTitle = null;
    state.breakSubtext = null;
  }

  function setPanelVisibility(visible) {
    if (!state.panel) {
      return;
    }

    state.panelVisible = visible;
    state.panel.hidden = !visible;
    state.panel.classList.toggle("is-visible", visible);
  }

  function showSuggestion() {
    if (!state.card) {
      return;
    }

    state.card.hidden = false;
    state.card.classList.add("is-visible");
    state.suggestionVisible = true;
  }

  function hideSuggestion() {
    if (!state.card) {
      return;
    }

    state.card.hidden = true;
    state.card.classList.remove("is-visible");
    state.suggestionVisible = false;
  }

  function startScrollSampling() {
    if (state.scrollListener) {
      return;
    }

    state.scrollListener = () => {
      if (!state.trackingEnabled) {
        return;
      }

      if (!state.scrollWindow) {
        state.scrollWindow = {
          startedAt: performance.now(),
          firstTimestamp: Date.now(),
          totalDistance: 0,
          directionChanges: 0,
          lastDirection: 0,
          lastProcessedY: window.scrollY
        };

        state.scrollTimeoutId = window.setTimeout(flushScrollWindow, 2000);
      }

      if (!state.rafScheduled) {
        state.rafScheduled = true;
        window.requestAnimationFrame(processScrollFrame);
      }
    };

    window.addEventListener("scroll", state.scrollListener, { passive: true });
  }

  function stopScrollSampling() {
    if (state.scrollListener) {
      window.removeEventListener("scroll", state.scrollListener);
    }

    state.scrollListener = null;
    state.scrollWindow = null;
    state.rafScheduled = false;

    if (state.scrollTimeoutId) {
      clearTimeout(state.scrollTimeoutId);
      state.scrollTimeoutId = null;
    }
  }

  function processScrollFrame() {
    state.rafScheduled = false;

    if (!state.scrollWindow) {
      return;
    }

    const currentY = window.scrollY;
    const delta = currentY - state.scrollWindow.lastProcessedY;

    if (delta !== 0) {
      const direction = Math.sign(delta);
      state.scrollWindow.totalDistance += Math.abs(delta);

      if (state.scrollWindow.lastDirection && direction !== state.scrollWindow.lastDirection) {
        state.scrollWindow.directionChanges += 1;
      }

      state.scrollWindow.lastDirection = direction;
      state.scrollWindow.lastProcessedY = currentY;
    }
  }

  function flushScrollWindow() {
    if (!state.scrollWindow) {
      return;
    }

    const elapsedMs = Math.max(performance.now() - state.scrollWindow.startedAt, 1);
    const velocity = Math.round((state.scrollWindow.totalDistance / elapsedMs) * 1000);
    const burst = state.scrollWindow.totalDistance >= 2400 || velocity >= 1400;

    chrome.runtime.sendMessage({
      type: "CONTENT_SCROLL_SAMPLE",
      payload: {
        timestamp: state.scrollWindow.firstTimestamp,
        distance: state.scrollWindow.totalDistance,
        velocity,
        directionChanges: state.scrollWindow.directionChanges,
        burst
      }
    }).catch(() => undefined);

    state.scrollWindow = null;
    state.scrollTimeoutId = null;
  }

  function formatSeconds(totalSeconds) {
    const safeSeconds = Math.max(totalSeconds, 0);
    const minutes = Math.floor(safeSeconds / 60);
    const seconds = safeSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function startBreakOverlay() {
    ensureUi();
    stopBreakOverlay();

    state.breakOverlayVisible = true;
    state.breakOverlay.hidden = false;
    state.breakOverlay.classList.add("is-visible");
    state.breakSecondsRemaining = state.live.uiPreferences.breakDurationSeconds || 60;
    state.breakTimerLabel.textContent = formatSeconds(state.breakSecondsRemaining);
    state.breakTitle.textContent = "Take a quiet minute";
    state.breakSubtext.textContent = "Look away from the screen, loosen your shoulders, and slow your breathing.";
    setPanelVisibility(false);
    hideSuggestion();

    state.breakTimerId = window.setInterval(() => {
      state.breakSecondsRemaining -= 1;
      state.breakTimerLabel.textContent = formatSeconds(state.breakSecondsRemaining);

      if (state.breakSecondsRemaining <= 0) {
        stopBreakOverlay();
      }
    }, 1000);
  }

  function stopBreakOverlay() {
    if (state.breakTimerId) {
      clearInterval(state.breakTimerId);
      state.breakTimerId = null;
    }

    state.breakSecondsRemaining = 0;

    if (state.breakOverlay) {
      state.breakOverlay.hidden = true;
      state.breakOverlay.classList.remove("is-visible");
    }

    state.breakOverlayVisible = false;
  }

  function applyStackPosition() {
    if (!state.stack) {
      return;
    }

    state.stack.dataset.position = state.live.uiPreferences.indicatorPosition || "bottom-right";
  }

  function renderWidget() {
    if (!state.widget) {
      return;
    }

    const score = clamp(Math.round(state.live.score || 0), 0, 100);
    const color = scoreColor(state.live.status);

    state.widget.style.setProperty("--clm-progress", `${score * 3.6}deg`);
    state.widget.style.setProperty("--clm-accent", color);
    state.widgetScore.textContent = String(score);
    state.widgetStatus.textContent = state.live.status;
    state.widget.title = `${state.live.status} load. ${statusDescription(state.live.status)}`;
    state.widget.classList.toggle("is-alert", state.live.status === "High");
  }

  function renderPanel() {
    if (!state.panel) {
      return;
    }

    const signals = state.live.signalCounts || {
      switches10m: 0,
      bursts5m: 0,
      idleMinutes10m: 0
    };

    state.panelTitle.textContent = `${state.live.status} load`;
    state.panelBody.textContent = statusDescription(state.live.status);
    state.panelScore.textContent = String(clamp(Math.round(state.live.score || 0), 0, 100));
    state.panelFocusButton.textContent = state.live.focusModeActive ? "Turn off focus" : "Focus mode";
    state.panelSignals.querySelector('[data-signal="switches"]').textContent = String(signals.switches10m || 0);
    state.panelSignals.querySelector('[data-signal="bursts"]').textContent = String(signals.bursts5m || 0);
    state.panelSignals.querySelector('[data-signal="idle"]').textContent = `${signals.idleMinutes10m || 0}m`;
  }

  function renderSuggestion() {
    if (!state.card) {
      return;
    }

    const threshold = state.live.uiPreferences.interventionThreshold || 70;
    const needsFocus = state.live.signalCounts.bursts5m >= state.live.signalCounts.switches10m;

    state.cardTitle.textContent = state.live.score >= threshold + 10 ? "Your pace is pretty dense" : "Take a lighter pace";
    state.cardBody.textContent = needsFocus
      ? "Rapid scanning is pushing your load up. A simpler reading view can help."
      : "Context switching is stacking up. A brief reset may help you settle back in.";
    state.cardSecondary.textContent = state.live.focusModeActive
      ? "Focus mode is already on. A short break may be the fastest relief."
      : "Try focus mode or a quick reset to lower the mental overhead.";
    state.card.querySelector('[data-card-action="focus"]').textContent = state.live.focusModeActive
      ? "Turn off focus"
      : "Simplify content";
  }

  function isElementEligible(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);

    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }

    return rect.width >= 280 && rect.height >= 180 && (element.innerText || "").trim().length >= 160;
  }

  function findBestContentTarget() {
    const selectors = ["main", "article", "[role='main']"];

    for (const selector of selectors) {
      const candidate = document.querySelector(selector);

      if (candidate && isElementEligible(candidate)) {
        return candidate;
      }
    }

    const candidates = Array.from(document.querySelectorAll("section, article, main, div"))
      .filter(isElementEligible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const textLength = (element.innerText || "").trim().length;
        return {
          element,
          score: rect.width * rect.height + textLength * 6
        };
      })
      .sort((left, right) => right.score - left.score);

    return candidates[0]?.element ?? null;
  }

  function updateHighlightPosition() {
    if (!state.focusHighlight || !state.live.focusModeActive) {
      return;
    }

    const target = findBestContentTarget();

    if (!target) {
      state.focusHighlight.hidden = true;
      return;
    }

    const rect = target.getBoundingClientRect();
    const padding = 18;
    const top = Math.max(rect.top - padding, 12);
    const left = Math.max(rect.left - padding, 12);
    const width = Math.min(rect.width + padding * 2, window.innerWidth - left - 12);
    const height = Math.min(rect.height + padding * 2, window.innerHeight - top - 12);

    state.focusHighlight.hidden = false;
    state.focusHighlight.style.top = `${top}px`;
    state.focusHighlight.style.left = `${left}px`;
    state.focusHighlight.style.width = `${Math.max(width, 180)}px`;
    state.focusHighlight.style.height = `${Math.max(height, 150)}px`;
  }

  function scheduleHighlightUpdate() {
    if (state.highlightFrame) {
      return;
    }

    state.highlightFrame = window.requestAnimationFrame(() => {
      state.highlightFrame = null;
      updateHighlightPosition();
    });
  }

  function applyFocusMode() {
    if (!state.focusVeil || !state.focusHighlight) {
      return;
    }

    state.focusVeil.hidden = false;
    state.focusVeil.style.setProperty("--clm-overlay-alpha", String((state.live.uiPreferences.focusOverlayStrength || 24) / 100));
    updateHighlightPosition();

    if (!state.focusListenersAttached) {
      window.addEventListener("scroll", scheduleHighlightUpdate, { passive: true });
      window.addEventListener("resize", scheduleHighlightUpdate, { passive: true });
      state.focusListenersAttached = true;
    }
  }

  function removeFocusMode() {
    if (state.focusVeil) {
      state.focusVeil.hidden = true;
    }

    if (state.focusHighlight) {
      state.focusHighlight.hidden = true;
    }

    if (state.focusListenersAttached) {
      window.removeEventListener("scroll", scheduleHighlightUpdate);
      window.removeEventListener("resize", scheduleHighlightUpdate);
      state.focusListenersAttached = false;
    }

    if (state.highlightFrame) {
      cancelAnimationFrame(state.highlightFrame);
      state.highlightFrame = null;
    }
  }

  async function handleLiveState(payload) {
    state.live = {
      ...state.live,
      ...payload,
      signalCounts: {
        ...state.live.signalCounts,
        ...(payload.signalCounts || {})
      },
      uiPreferences: {
        ...state.live.uiPreferences,
        ...(payload.uiPreferences || {})
      }
    };
    state.trackingEnabled = Boolean(state.live.trackingEnabled);

    if (!state.trackingEnabled) {
      teardownUi();
      return;
    }

    ensureUi();
    startScrollSampling();
    applyStackPosition();
    renderWidget();
    renderPanel();
    renderSuggestion();

    if (state.live.focusModeActive) {
      applyFocusMode();
    } else {
      removeFocusMode();
    }

    if (state.live.interventionEligible && state.live.score >= state.live.uiPreferences.interventionThreshold) {
      if (!state.suggestionVisible) {
        await chrome.runtime.sendMessage({ type: "INTERVENTION_SHOWN" }).catch(() => undefined);
        showSuggestion();
      }
    } else if (state.suggestionVisible && !state.breakOverlayVisible) {
      hideSuggestion();
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "LIVE_STATE_UPDATED" && message.payload) {
      handleLiveState(message.payload).catch((error) => {
        console.error("Cognitive Load Meter content update failed", error);
      });
    }
  });

  chrome.runtime.sendMessage({ type: "GET_LIVE_STATE" }).then((payload) => {
    if (payload) {
      handleLiveState(payload).catch((error) => {
        console.error("Cognitive Load Meter content bootstrap failed", error);
      });
    }
  }).catch(() => undefined);
})();
