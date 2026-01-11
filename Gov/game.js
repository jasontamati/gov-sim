// Governance MPL - rewritten game loop (HTML/CSS/JS)
// Goals of this rewrite:
// - Keep "tick()" deterministic and single-responsibility.
// - Support BOTH real-time and turn-based (End Day) without touching tick logic.
// - Add variable speed controls + clean pause handling.
// - Keep architecture simple: state -> tick -> render; actions mutate state; events are declarative.
//
// Requires existing IDs in index.html:
// day, statusBadge, pop, food, wood, stab, rates, farms, log, eventBox,
// toggleTick, reset, wfFood, wfWood, wfFoodVal, wfWoodVal
//
// OPTIONAL (supported if you add them to HTML):
// endDay, speed1, speed2, speed4 (or any buttons with data-speed="10000|5000|2500")

(() => {
  "use strict";

  // -------------------------------
  // DOM
  // -------------------------------
  const $ = (id) => document.getElementById(id);

  const ui = {
    day: $("day"),
    statusBadge: $("statusBadge"),
    pop: $("pop"),
    food: $("food"),
    wood: $("wood"),
    stab: $("stab"),
    rates: $("rates"),
    farms: $("farms"),
    log: $("log"),
    eventBox: $("eventBox"),

    toggleTick: $("toggleTick"),
    reset: $("reset"),

    endDay: $("endDay"), // optional
    wfFood: $("wfFood"),
    wfWood: $("wfWood"),
    wfFoodVal: $("wfFoodVal"),
    wfWoodVal: $("wfWoodVal"),
  };

  // -------------------------------
  // Constants (tune here)
  // -------------------------------
  const CONFIG = {
    // Time control
    DEFAULT_MODE: "auto", // "auto" | "manual"
    DEFAULT_SPEED_MS: 5000, // 1 day = 5 seconds (auto mode)

    // Economy
    FOOD_PER_WORKER: 1.0,
    WOOD_PER_WORKER: 0.8,

    FARM_WOOD_COST: 30,
    FARM_FOOD_MULT_PER_FARM: 0.08, // +8% food output per farm

    // Consumption
    FOOD_CONSUMPTION_PER_POP: 1.0,
    RATION_CONSUMPTION_MULT: 0.75,
    FEAST_CONSUMPTION_MULT: 1.25,

    // Policies durations (days)
    RATION_DAYS: 5,
    FEAST_DAYS: 3,

    // Stability dynamics
    STAB_MAX: 100,
    STAB_MIN: 0,

    // Starvation penalties
    STARVATION_STAB_LOSS_MULT: 0.15, // per missing food unit
    STARVATION_STAB_LOSS_MIN: 2,
    STARVATION_STAB_LOSS_MAX: 18,
    STARVATION_DEATH_DEFICIT_RATIO: 0.8, // deficit > pop*ratio can kill
    STARVATION_DEATH_CHANCE: 0.5,

    // Ambient stability drift
    STAB_DRIFT_UP_IF_WELL_FED_RATIO: 3, // food > pop*ratio => drift up
    STAB_DRIFT_UP: 0.6,
    STAB_DRIFT_CAP: 85,
    STAB_DRIFT_DOWN_IF_TOO_HIGH: 0.2,
    STAB_TOO_HIGH: 90,

    // Events
    EVENT_BASE_CHANCE: 0.05,
    EVENT_STARVATION_BONUS: 0.12,
    EVENT_LOWSTAB_BONUS: 0.10,
    LOW_STABILITY_THRESHOLD: 35,
    STARVATION_RISK_FOOD_RATIO: 2, // food < pop*ratio => risk

    // Win/Lose
    WIN_DAY: 50,
  };

  // -------------------------------
  // State
  // -------------------------------
  const INITIAL = () => ({
    // timeline
    day: 1,
    mode: CONFIG.DEFAULT_MODE,     // "auto" or "manual"
    paused: false,
    gameOver: false,

    // core resources
    pop: 30,
    food: 80,
    wood: 40,
    stability: 70,

    // workforce
    workersFood: 10,
    workersWood: 5,

    // buildings
    farms: 0,

    // policies (timers)
    rationing: 0,
    feasting: 0,

    // event
    activeEvent: null,

    // tick timer
    tickSpeedMs: CONFIG.DEFAULT_SPEED_MS,
  });

  let state = INITIAL();

  // -------------------------------
  // Timer control
  // -------------------------------
  let tickHandle = null;

  function startAutoTick() {
    stopAutoTick();
    tickHandle = window.setInterval(() => tick(), state.tickSpeedMs);
  }

  function stopAutoTick() {
    if (tickHandle !== null) {
      window.clearInterval(tickHandle);
      tickHandle = null;
    }
  }

  function applyTimeControl() {
    // Manual mode means no interval ticks. Auto mode means interval, unless paused/game over.
    stopAutoTick();

    if (state.gameOver) return;

    if (state.mode === "auto" && !state.paused) startAutoTick();
  }

  // -------------------------------
  // Utils
  // -------------------------------
  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  function rndInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function fmtInt(n) {
    return String(Math.floor(n));
  }

  function logLine(text, tone = "") {
    if (!ui.log) return;
    const div = document.createElement("div");
    div.className = `line ${tone}`;
    div.textContent = `[Day ${state.day}] ${text}`;
    ui.log.prepend(div);
  }

  function statusLabel() {
    if (state.gameOver) return { text: "GAME OVER", tone: "bad" };
    if (state.stability >= 75) return { text: "Stable", tone: "good" };
    if (state.stability >= 40) return { text: "Tense", tone: "warn" };
    return { text: "Unstable", tone: "bad" };
  }

  // -------------------------------
  // Core math
  // -------------------------------
  function farmBonusMult() {
    return 1 + (state.farms * CONFIG.FARM_FOOD_MULT_PER_FARM);
  }

  function foodPerDay() {
    return state.workersFood * CONFIG.FOOD_PER_WORKER * farmBonusMult();
  }

  function woodPerDay() {
    return state.workersWood * CONFIG.WOOD_PER_WORKER;
  }

  function foodConsumptionPerDay() {
    let consumption = state.pop * CONFIG.FOOD_CONSUMPTION_PER_POP;
    if (state.rationing > 0) consumption *= CONFIG.RATION_CONSUMPTION_MULT;
    if (state.feasting > 0) consumption *= CONFIG.FEAST_CONSUMPTION_MULT;
    return consumption;
  }

  function validateWorkforce() {
    // Ensure total workers <= population. Clamp wood first, then food.
    const total = state.workersFood + state.workersWood;
    if (total <= state.pop) return;

    let overflow = total - state.pop;

    if (state.workersWood >= overflow) {
      state.workersWood -= overflow;
      return;
    }

    overflow -= state.workersWood;
    state.workersWood = 0;
    state.workersFood = clamp(state.workersFood - overflow, 0, state.pop);
  }

  // -------------------------------
  // Events (declarative)
  // -------------------------------
  function buildEvent(key) {
    switch (key) {
      case "TRADERS":
        return {
          key,
          title: "Wandering Traders Arrive",
          body: "They offer food for wood. Fair deal, but your stores matter.",
          options: [
            {
              label: "Trade 20 wood → 35 food",
              can: () => state.wood >= 20,
              apply: () => {
                state.wood -= 20;
                state.food += 35;
                state.stability = clamp(state.stability + 2, CONFIG.STAB_MIN, CONFIG.STAB_MAX);
                logLine("You traded with the traders. Supplies improved.", "good");
              },
            },
            {
              label: "Refuse",
              can: () => true,
              apply: () => {
                state.stability = clamp(state.stability - 1, CONFIG.STAB_MIN, CONFIG.STAB_MAX);
                logLine("You refused the traders.", "");
              },
            },
          ],
        };

      case "THEFT":
        return {
          key,
          title: "Food Theft at Night",
          body: "Hungry citizens stole from stores. You must respond.",
          options: [
            {
              label: "Punish harshly (order now, risk death)",
              can: () => true,
              apply: () => {
                state.stability = clamp(state.stability + 6, CONFIG.STAB_MIN, CONFIG.STAB_MAX);
                if (Math.random() < 0.35) {
                  state.pop = clamp(state.pop - 1, 0, 999999);
                  logLine("Harsh punishment restored order—at a human cost.", "warn");
                } else {
                  logLine("Harsh punishment restored order.", "warn");
                }
              },
            },
            {
              label: "Show mercy (authority down)",
              can: () => true,
              apply: () => {
                state.stability = clamp(state.stability - 6, CONFIG.STAB_MIN, CONFIG.STAB_MAX);
                state.food = clamp(state.food - 6, 0, 999999);
                logLine("Mercy preserved lives but weakened authority.", "bad");
              },
            },
          ],
        };

      case "RIOT":
        return {
          key,
          title: "Public Riot",
          body: "Crowds gather, angry and scared. This can spiral.",
          options: [
            {
              label: "Spend 25 food to calm them",
              can: () => state.food >= 25,
              apply: () => {
                state.food -= 25;
                state.stability = clamp(state.stability + 15, CONFIG.STAB_MIN, CONFIG.STAB_MAX);
                logLine("You defused the riot with emergency supplies.", "good");
              },
            },
            {
              label: "Use force (can backfire)",
              can: () => true,
              apply: () => {
                state.stability = clamp(state.stability + 8, CONFIG.STAB_MIN, CONFIG.STAB_MAX);
                if (Math.random() < 0.5) {
                  const loss = rndInt(5, 18);
                  state.wood = clamp(state.wood - loss, 0, 999999);
                  state.stability = clamp(state.stability - 10, CONFIG.STAB_MIN, CONFIG.STAB_MAX);
                  logLine(`Force backfired: property damage (-${loss} wood).`, "bad");
                } else {
                  logLine("Force ended the riot quickly.", "warn");
                }
              },
            },
          ],
        };

      default:
        return {
          key: "NONE",
          title: "Quiet Day",
          body: "Nothing happens.",
          options: [{ label: "Ok", can: () => true, apply: () => {} }],
        };
    }
  }

  function maybeTriggerEvent() {
    if (state.activeEvent || state.gameOver) return;

    const starvationRisk = state.food < state.pop * CONFIG.STARVATION_RISK_FOOD_RATIO;
    const lowStability = state.stability < CONFIG.LOW_STABILITY_THRESHOLD;

    let chance = CONFIG.EVENT_BASE_CHANCE;
    if (starvationRisk) chance += CONFIG.EVENT_STARVATION_BONUS;
    if (lowStability) chance += CONFIG.EVENT_LOWSTAB_BONUS;

    if (Math.random() > chance) return;

    const pool = ["TRADERS"];
    if (starvationRisk) pool.push("THEFT");
    if (lowStability) pool.push("RIOT");

    const pick = pool[rndInt(0, pool.length - 1)];
    state.activeEvent = buildEvent(pick);
    renderEvent();
  }

  function resolveEvent(optionIndex) {
    const ev = state.activeEvent;
    if (!ev) return;

    const opt = ev.options?.[optionIndex];
    if (!opt || !opt.can()) return;

    opt.apply();
    state.activeEvent = null;
    renderEvent();
    render();
  }

  // -------------------------------
  // Actions (player-driven)
  // -------------------------------
  const actions = {
    workFood: () => {
      state.workersFood = clamp(state.workersFood + 1, 0, state.pop);
      validateWorkforce();
      logLine("Shifted labor toward food production.", "");
    },

    workWood: () => {
      state.workersWood = clamp(state.workersWood + 1, 0, state.pop);
      validateWorkforce();
      logLine("Shifted labor toward wood gathering.", "");
    },

    buildFarm: () => {
      const cost = CONFIG.FARM_WOOD_COST;
      if (state.wood < cost) {
        logLine("Not enough wood to build a farm.", "bad");
        return;
      }
      state.wood -= cost;
      state.farms += 1;
      state.stability = clamp(state.stability + 2, CONFIG.STAB_MIN, CONFIG.STAB_MAX);
      logLine("Built a farm. Food output will scale better.", "good");
    },

    ration: () => {
      state.rationing = CONFIG.RATION_DAYS;
      state.feasting = 0;
      state.stability = clamp(state.stability - 6, CONFIG.STAB_MIN, CONFIG.STAB_MAX);
      logLine(`Rationing enforced for ${CONFIG.RATION_DAYS} days.`, "warn");
    },

    feast: () => {
      if (state.food < 20) {
        logLine("Not enough food to feast.", "bad");
        return;
      }
      state.feasting = CONFIG.FEAST_DAYS;
      state.rationing = 0;
      state.food -= 10;
      state.stability = clamp(state.stability + 8, CONFIG.STAB_MIN, CONFIG.STAB_MAX);
      logLine(`Feast declared for ${CONFIG.FEAST_DAYS} days.`, "good");
    },
  };

  function wireActionButtons() {
    document.querySelectorAll("button[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (state.gameOver) return;
        const key = btn.getAttribute("data-action");
        const fn = actions[key];
        if (typeof fn !== "function") return;
        fn();
        render();
      });
    });
  }

  // -------------------------------
  // Tick (1 day)
  // -------------------------------
  function tick() {
    if (state.gameOver) return;
    if (state.paused && state.mode === "auto") return; // manual mode ignores pause

    validateWorkforce();

    // Policy timers
    if (state.rationing > 0) state.rationing -= 1;
    if (state.feasting > 0) state.feasting -= 1;

    // Production
    const fp = foodPerDay();
    const wp = woodPerDay();
    state.food += fp;
    state.wood += wp;

    // Consumption
    const cons = foodConsumptionPerDay();
    state.food -= cons;

    // Starvation effects
    if (state.food < 0) {
      const deficit = Math.abs(state.food);
      state.food = 0;

      const stabLoss = clamp(
        deficit * CONFIG.STARVATION_STAB_LOSS_MULT,
        CONFIG.STARVATION_STAB_LOSS_MIN,
        CONFIG.STARVATION_STAB_LOSS_MAX
      );
      state.stability = clamp(state.stability - stabLoss, CONFIG.STAB_MIN, CONFIG.STAB_MAX);

      if (deficit > state.pop * CONFIG.STARVATION_DEATH_DEFICIT_RATIO && Math.random() < CONFIG.STARVATION_DEATH_CHANCE) {
        state.pop = clamp(state.pop - 1, 0, 999999);
        logLine("Starvation claimed a life.", "bad");
      } else {
        logLine("Food shortage hit stability hard.", "warn");
      }
    }

    // Ambient drift
    if (state.food > state.pop * CONFIG.STAB_DRIFT_UP_IF_WELL_FED_RATIO && state.stability < CONFIG.STAB_DRIFT_CAP) {
      state.stability = clamp(state.stability + CONFIG.STAB_DRIFT_UP, CONFIG.STAB_MIN, CONFIG.STAB_MAX);
    }
    if (state.stability > CONFIG.STAB_TOO_HIGH) {
      state.stability = clamp(state.stability - CONFIG.STAB_DRIFT_DOWN_IF_TOO_HIGH, CONFIG.STAB_MIN, CONFIG.STAB_MAX);
    }

    // Events
    maybeTriggerEvent();

    // Lose conditions
    if (state.pop <= 0) return endGame("Population collapsed.");
    if (state.stability <= 0) return endGame("Authority collapsed.");

    // Win condition
    if (state.day >= CONFIG.WIN_DAY) return endGame(`You survived ${CONFIG.WIN_DAY} days. MPL complete.`, true);

    // Advance time
    state.day += 1;
    render();
  }

  function endGame(reason, win = false) {
    state.gameOver = true;
    logLine(reason, win ? "good" : "bad");
    applyTimeControl(); // ensure timer stops
    render(); // refresh badge
  }

  // -------------------------------
  // Render
  // -------------------------------
  function renderEvent() {
    if (!ui.eventBox) return;

    const ev = state.activeEvent;
    if (!ev) {
      ui.eventBox.className = "event empty";
      ui.eventBox.innerHTML = `
        <div class="event-title">No active event</div>
        <div class="event-body">Keep the settlement alive.</div>
      `;
      return;
    }

    ui.eventBox.className = "event";
    const actionsHtml = (ev.options || [])
      .map((opt, idx) => {
        const disabled = opt.can() ? "" : "disabled";
        return `<button ${disabled} data-ev="${idx}">${opt.label}</button>`;
      })
      .join("");

    ui.eventBox.innerHTML = `
      <div class="event-title">${ev.title}</div>
      <div class="event-body">${ev.body}</div>
      <div class="event-actions">${actionsHtml}</div>
    `;

    ui.eventBox.querySelectorAll("button[data-ev]").forEach((b) => {
      b.addEventListener("click", () => resolveEvent(Number(b.getAttribute("data-ev"))));
    });
  }

  function syncWorkforceUItoState() {
    if (!ui.wfFood || !ui.wfWood) return;

    ui.wfFood.max = String(state.pop);
    ui.wfWood.max = String(state.pop);

    ui.wfFood.value = String(state.workersFood);
    ui.wfWood.value = String(state.workersWood);

    if (ui.wfFoodVal) ui.wfFoodVal.textContent = String(state.workersFood);
    if (ui.wfWoodVal) ui.wfWoodVal.textContent = String(state.workersWood);
  }

  function render() {
    const s = statusLabel();

    if (ui.day) ui.day.textContent = `Day ${state.day}`;

    if (ui.statusBadge) {
      ui.statusBadge.textContent = s.text;
      const color =
        s.tone === "good" ? "var(--good)" :
        s.tone === "warn" ? "var(--warn)" :
        "var(--bad)";
      ui.statusBadge.style.color = color;
      ui.statusBadge.style.borderColor = color;
    }

    if (ui.pop) ui.pop.textContent = fmtInt(state.pop);
    if (ui.food) ui.food.textContent = fmtInt(state.food);
    if (ui.wood) ui.wood.textContent = fmtInt(state.wood);
    if (ui.stab) ui.stab.textContent = `${fmtInt(state.stability)} / ${CONFIG.STAB_MAX}`;

    if (ui.farms) ui.farms.textContent = fmtInt(state.farms);

    if (ui.rates) {
      const fp = foodPerDay();
      const wp = woodPerDay();
      const cons = foodConsumptionPerDay();

      const pol = [
        state.rationing > 0 ? `Rationing(${state.rationing}d)` : null,
        state.feasting > 0 ? `Feast(${state.feasting}d)` : null,
      ].filter(Boolean).join(" ");

      ui.rates.textContent =
        `Rates: +${fp.toFixed(1)} food/day, +${wp.toFixed(1)} wood/day, -${cons.toFixed(1)} food/day consumption. ` +
        `Mode: ${state.mode}${state.mode === "auto" ? ` @ ${Math.round(state.tickSpeedMs/1000)}s/day` : ""}. ` +
        `Policies: ${pol || "none"}.`;
    }

    // Disable/enable action buttons
    document.querySelectorAll("button[data-action]").forEach((btn) => {
      const key = btn.getAttribute("data-action");
      const over = state.gameOver;

      if (key === "buildFarm") btn.disabled = over || state.wood < CONFIG.FARM_WOOD_COST;
      else if (key === "feast") btn.disabled = over || state.food < 20;
      else btn.disabled = over;
    });

    // Update toggle tick label
    if (ui.toggleTick) {
      if (state.mode === "manual") ui.toggleTick.textContent = "Manual Mode";
      else ui.toggleTick.textContent = state.paused ? "Resume" : "Pause";
      ui.toggleTick.disabled = state.gameOver;
    }

    if (ui.endDay) {
      ui.endDay.disabled = state.gameOver;
      ui.endDay.style.display = state.mode === "manual" ? "" : "none";
    }

    syncWorkforceUItoState();
  }

  // -------------------------------
  // Wiring: UI controls
  // -------------------------------
  function wireWorkforceSliders() {
    if (ui.wfFood) {
      ui.wfFood.addEventListener("input", () => {
        state.workersFood = Number(ui.wfFood.value);
        validateWorkforce();
        syncWorkforceUItoState();
        render();
      });
    }

    if (ui.wfWood) {
      ui.wfWood.addEventListener("input", () => {
        state.workersWood = Number(ui.wfWood.value);
        validateWorkforce();
        syncWorkforceUItoState();
        render();
      });
    }
  }

  function wireTimeControls() {
    // ToggleTick behavior:
    // - If manual mode: toggles to auto mode and starts ticking (default speed).
    // - If auto mode: toggles pause/resume.
    if (ui.toggleTick) {
      ui.toggleTick.addEventListener("click", () => {
        if (state.gameOver) return;

        if (state.mode === "manual") {
          state.mode = "auto";
          state.paused = false;
          logLine("Switched to auto time.", "");
        } else {
          state.paused = !state.paused;
          logLine(state.paused ? "Paused time." : "Resumed time.", "");
        }

        applyTimeControl();
        render();
      });
    }

    // Manual End Day
    if (ui.endDay) {
      ui.endDay.addEventListener("click", () => {
        if (state.gameOver) return;
        // Manual mode ignores pause and timer; you control days.
        tick();
      });
    }

    // Optional speed buttons: any element with data-speed="ms"
    document.querySelectorAll("[data-speed]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (state.gameOver) return;

        const ms = Number(btn.getAttribute("data-speed"));
        if (!Number.isFinite(ms) || ms <= 0) return;

        state.tickSpeedMs = ms;

        // If currently manual, switch to auto so speed matters
        if (state.mode !== "auto") {
          state.mode = "auto";
          state.paused = false;
          logLine("Switched to auto time.", "");
        }

        logLine(`Set speed to ${Math.round(ms / 1000)}s/day.`, "");
        applyTimeControl();
        render();
      });
    });
  }

  function wireReset() {
    if (!ui.reset) return;

    ui.reset.addEventListener("click", () => {
      stopAutoTick();
      state = INITIAL();

      if (ui.log) ui.log.innerHTML = "";
      logLine("New run started.", "");

      renderEvent();
      render();
      applyTimeControl();
    });
  }

  function wireModeHotkey() {
    // Press "M" to toggle manual/auto (handy while designing)
    window.addEventListener("keydown", (e) => {
      if (e.key.toLowerCase() !== "m") return;
      if (state.gameOver) return;

      state.mode = state.mode === "auto" ? "manual" : "auto";
      state.paused = false;

      logLine(`Mode -> ${state.mode}.`, "");
      applyTimeControl();
      render();
    });
  }

  // -------------------------------
  // Boot
  // -------------------------------
  function boot() {
    wireActionButtons();
    wireWorkforceSliders();
    wireTimeControls();
    wireReset();
    wireModeHotkey();

    logLine("New run started.", "");
    renderEvent();
    render();
    applyTimeControl();
  }

  boot();
})();
