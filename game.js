// Governance MPL-B (Tools) - full file
// What this branch tests:
// - Does "efficiency + maintenance" (Tools with decay) prevent late-game coasting?
// - Do allocation trade-offs (Food vs Wood vs Tools) stay meaningful over 50 days?
// - Does neglect cause gradual systemic decline (not just sudden famine)?
//
// Notes:
// - Population remains capped/static by default (only decreases via events/starvation).
// - Tools are a shared pool that boosts productivity with diminishing returns.
// - Tools decay daily (wear) and can be replenished by assigning workers to Tools.
//
// UI IDs expected (existing from MPL-A):
// day, statusBadge, pop, food, wood, stab, rates, farms, log, eventBox,
// toggleTick, reset, wfFood, wfWood, wfFoodVal, wfWoodVal
//
// OPTIONAL UI IDs for Tools (recommended for MPL-B):
// tools (stat display), wfTools (range input), wfToolsVal (span value)
//
// OPTIONAL time controls (supported if present):
// endDay, and/or any element with data-speed="5000" etc.

(() => {
  "use strict";

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
    tools: $("tools"), // optional

    log: $("log"),
    eventBox: $("eventBox"),

    toggleTick: $("toggleTick"),
    reset: $("reset"),
    endDay: $("endDay"), // optional

    wfFood: $("wfFood"),
    wfWood: $("wfWood"),
    wfTools: $("wfTools"), // optional

    wfFoodVal: $("wfFoodVal"),
    wfWoodVal: $("wfWoodVal"),
    wfToolsVal: $("wfToolsVal"), // optional
  };

  // -------------------------------
  // Balance constants
  // -------------------------------
  const CONFIG = {
    // Time control
    DEFAULT_MODE: "auto",      // "auto" | "manual"
    DEFAULT_SPEED_MS: 5000,    // 1 day = 5 seconds

    // Base production
    FOOD_PER_WORKER: 1.0,
    WOOD_PER_WORKER: 0.8,

    // Farms
    FARM_WOOD_COST: 30,
    FARM_FOOD_MULT_PER_FARM: 0.08,  // +8% food output per farm

    // Consumption
    FOOD_CONSUMPTION_PER_POP: 1.0,
    RATION_CONSUMPTION_MULT: 0.75,
    FEAST_CONSUMPTION_MULT: 1.25,

    // Policies (days)
    RATION_DAYS: 5,
    FEAST_DAYS: 3,

    // Stability
    STAB_MIN: 0,
    STAB_MAX: 100,

    // Starvation penalties
    STARVATION_STAB_LOSS_MULT: 0.15,
    STARVATION_STAB_LOSS_MIN: 2,
    STARVATION_STAB_LOSS_MAX: 18,
    STARVATION_DEATH_DEFICIT_RATIO: 0.8,
    STARVATION_DEATH_CHANCE: 0.5,

    // Ambient stability drift
    STAB_DRIFT_UP_IF_WELL_FED_RATIO: 3,
    STAB_DRIFT_UP: 0.6,
    STAB_DRIFT_CAP: 85,
    STAB_DRIFT_DOWN_IF_TOO_HIGH: 0.2,
    STAB_TOO_HIGH: 90,

    // Events
    EVENT_BASE_CHANCE: 0.05,
    EVENT_STARVATION_BONUS: 0.12,
    EVENT_LOWSTAB_BONUS: 0.10,
    LOW_STABILITY_THRESHOLD: 35,
    STARVATION_RISK_FOOD_RATIO: 2,

    // Win/Lose
    WIN_DAY: 50,

    // -------------------------------
    // Tools system (MPL-B core)
    // -------------------------------

    // Toolmaking:
    // Each worker on tools attempts to produce TOOLS_PER_WORKER tools per day,
    // but is limited by available wood (WOOD_PER_TOOL).
    TOOLS_PER_WORKER: 0.35,     // tools/day per worker assigned to tools
    WOOD_PER_TOOL: 0.75,        // wood cost per tool produced

    // Tool productivity effects (shared pool):
    // Tools boost output with diminishing returns based on "tools per pop".
    // - If tools are scarce, multiplier is near 1.0
    // - If tools are abundant, multiplier approaches (1 + max bonus)
    TOOLS_TARGET_PER_POP: 1.0,  // "healthy" tools per person
    TOOLS_MAX_OUTPUT_BONUS: 0.45, // +45% max bonus to production from tools
    TOOLS_CURVE_SHARPNESS: 1.6, // >1 means slower early ramp, stronger later

    // Tool decay:
    // Tools wear out daily; higher workload slightly increases decay.
    TOOLS_BASE_DECAY_RATE: 0.03, // 3% of tools/day baseline wear
    TOOLS_WORKLOAD_DECAY_ADD: 0.01, // +1% if total workers ~pop (high utilization)
    TOOLS_MIN_DECAY: 0.05,       // minimum absolute tools lost per day
  };

  // -------------------------------
  // State
  // -------------------------------
  const INITIAL = () => ({
    day: 1,
    mode: CONFIG.DEFAULT_MODE,
    paused: false,
    gameOver: false,

    pop: 30,
    food: 80,
    wood: 40,
    stability: 70,

    // Workforce
    workersFood: 10,
    workersWood: 5,
    workersTools: 0, // new

    // Buildings
    farms: 0,

    // Policies
    rationing: 0,
    feasting: 0,

    // Tools (shared pool)
    tools: 10, // starting stock (small)

    // Events
    activeEvent: null,

    // Tick timer
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

  // Tools multiplier: diminishing returns based on tools per pop
  // ratio = tools / (pop * target)
  // multiplier = 1 + maxBonus * (ratio^k / (1 + ratio^k))
  function toolsOutputMult() {
    const denom = Math.max(1, state.pop) * CONFIG.TOOLS_TARGET_PER_POP;
    const ratio = state.tools / Math.max(1e-6, denom);
    const k = CONFIG.TOOLS_CURVE_SHARPNESS;

    const x = Math.pow(ratio, k);
    const saturating = x / (1 + x);

    return 1 + (CONFIG.TOOLS_MAX_OUTPUT_BONUS * saturating);
  }

  function foodPerDay() {
    return state.workersFood * CONFIG.FOOD_PER_WORKER * farmBonusMult() * toolsOutputMult();
  }

  function woodPerDay() {
    return state.workersWood * CONFIG.WOOD_PER_WORKER * toolsOutputMult();
  }

  function foodConsumptionPerDay() {
    let consumption = state.pop * CONFIG.FOOD_CONSUMPTION_PER_POP;
    if (state.rationing > 0) consumption *= CONFIG.RATION_CONSUMPTION_MULT;
    if (state.feasting > 0) consumption *= CONFIG.FEAST_CONSUMPTION_MULT;
    return consumption;
  }

  function validateWorkforce() {
    // Ensure total workers <= population. Clamp tools first, then wood, then food.
    const total = state.workersFood + state.workersWood + state.workersTools;
    if (total <= state.pop) return;

    let overflow = total - state.pop;

    // Reduce tools
    if (state.workersTools >= overflow) {
      state.workersTools -= overflow;
      return;
    }
    overflow -= state.workersTools;
    state.workersTools = 0;

    // Reduce wood
    if (state.workersWood >= overflow) {
      state.workersWood -= overflow;
      return;
    }
    overflow -= state.workersWood;
    state.workersWood = 0;

    // Reduce food
    state.workersFood = clamp(state.workersFood - overflow, 0, state.pop);
  }

  // -------------------------------
  // Tools system
  // -------------------------------
  function toolsMadePerDayPotential() {
    return state.workersTools * CONFIG.TOOLS_PER_WORKER;
  }

  function toolsWoodRequired(potentialTools) {
    return potentialTools * CONFIG.WOOD_PER_TOOL;
  }

  function applyToolmaking() {
    if (state.workersTools <= 0) return { made: 0, woodSpent: 0 };

    const potential = toolsMadePerDayPotential();
    if (potential <= 0) return { made: 0, woodSpent: 0 };

    const woodNeeded = toolsWoodRequired(potential);

    // If insufficient wood, scale down production
    let scale = 1;
    if (state.wood < woodNeeded) {
      scale = state.wood / Math.max(1e-6, woodNeeded);
    }

    const made = potential * scale;
    const woodSpent = woodNeeded * scale;

    state.wood -= woodSpent;
    state.tools += made;

    // If we were wood-starved, log occasionally (not every day spam)
    if (scale < 0.5 && Math.random() < 0.25) {
      logLine("Toolmaking stalled due to low wood.", "warn");
    }

    return { made, woodSpent };
  }

  function applyToolDecay() {
    // Wear depends on utilization: if total assigned workers ~ pop, tools wear faster.
    const totalWorkers = state.workersFood + state.workersWood + state.workersTools;
    const utilization = totalWorkers / Math.max(1, state.pop);

    const add = utilization > 0.85 ? CONFIG.TOOLS_WORKLOAD_DECAY_ADD : 0;
    const rate = CONFIG.TOOLS_BASE_DECAY_RATE + add;

    const loss = Math.max(CONFIG.TOOLS_MIN_DECAY, state.tools * rate);
    state.tools = clamp(state.tools - loss, 0, 999999);

    return loss;
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
          body: "They offer goods for wood. You can also buy tools.",
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
              label: "Trade 15 wood → 10 tools",
              can: () => state.wood >= 15,
              apply: () => {
                state.wood -= 15;
                state.tools += 10;
                state.stability = clamp(state.stability + 1, CONFIG.STAB_MIN, CONFIG.STAB_MAX);
                logLine("You acquired tools from the traders.", "good");
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
          title: "Theft at Night",
          body: "Hungry citizens stole from stores—some tools went missing.",
          options: [
            {
              label: "Punish harshly (order now, risk death)",
              can: () => true,
              apply: () => {
                state.stability = clamp(state.stability + 6, CONFIG.STAB_MIN, CONFIG.STAB_MAX);
                state.tools = clamp(state.tools - 2, 0, 999999);
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
          body: "Crowds gather, angry and scared. Property (and tools) may be damaged.",
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
                  const lossWood = rndInt(5, 18);
                  const lossTools = rndInt(1, 6);
                  state.wood = clamp(state.wood - lossWood, 0, 999999);
                  state.tools = clamp(state.tools - lossTools, 0, 999999);
                  state.stability = clamp(state.stability - 10, CONFIG.STAB_MIN, CONFIG.STAB_MAX);
                  logLine(`Force backfired: property damage (-${lossWood} wood, -${lossTools} tools).`, "bad");
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
  // Player actions
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
    if (state.paused && state.mode === "auto") return;

    validateWorkforce();

    // Policy timers
    if (state.rationing > 0) state.rationing -= 1;
    if (state.feasting > 0) state.feasting -= 1;

    // Production (food + wood)
    const fp = foodPerDay();
    const wp = woodPerDay();
    state.food += fp;
    state.wood += wp;

    // Toolmaking (converts wood -> tools using workersTools)
    const tm = applyToolmaking();

    // Consumption
    const cons = foodConsumptionPerDay();
    state.food -= cons;

    // Tool decay (wear)
    const toolLoss = applyToolDecay();

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
      } elset {
        logLine("Food shortage hit stability hard.", "warn");
      }
    }

    // Ambient stability drift
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
    if (state.day >= CONFIG.WIN_DAY) return endGame(`You survived ${CONFIG.WIN_DAY} days. MPL-B complete.`, true);

    // Occasional tool economy log (not spam)
    if ((state.day % 7) === 0) {
      const mult = toolsOutputMult();
      logLine(
        `Tools report: ${Math.floor(state.tools)} tools, wear -${toolLoss.toFixed(1)}/day, output x${mult.toFixed(2)}.`,
        "warn"
      );
    }

    state.day += 1;
    render();
  }

  function endGame(reason, win = false) {
    state.gameOver = true;
    logLine(reason, win ? "good" : "bad");
    applyTimeControl();
    render();
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
    // Existing sliders
    if (ui.wfFood) {
      ui.wfFood.max = String(state.pop);
      ui.wfFood.value = String(state.workersFood);
      if (ui.wfFoodVal) ui.wfFoodVal.textContent = String(state.workersFood);
    }

    if (ui.wfWood) {
      ui.wfWood.max = String(state.pop);
      ui.wfWood.value = String(state.workersWood);
      if (ui.wfWoodVal) ui.wfWoodVal.textContent = String(state.workersWood);
    }

    // Optional tools slider
    if (ui.wfTools) {
      ui.wfTools.max = String(state.pop);
      ui.wfTools.value = String(state.workersTools);
      if (ui.wfToolsVal) ui.wfToolsVal.textContent = String(state.workersTools);
    }
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
    if (ui.tools) ui.tools.textContent = fmtInt(state.tools);

    // Rates line
    if (ui.rates) {
      const fp = foodPerDay();
      const wp = woodPerDay();
      const cons = foodConsumptionPerDay();
      const mult = toolsOutputMult();

      const potentialTools = toolsMadePerDayPotential();
      const woodNeed = toolsWoodRequired(potentialTools);

      const pol = [
        state.rationing > 0 ? `Rationing(${state.rationing}d)` : null,
        state.feasting > 0 ? `Feast(${state.feasting}d)` : null,
      ].filter(Boolean).join(" ");

      ui.rates.textContent =
        `Rates: +${fp.toFixed(1)} food/day, +${wp.toFixed(1)} wood/day, -${cons.toFixed(1)} food/day consumption. ` +
        `Tools: x${mult.toFixed(2)} output; make ~${potentialTools.toFixed(2)}/day (needs ${woodNeed.toFixed(1)} wood/day). ` +
        `Mode: ${state.mode}${state.mode === "auto" ? ` @ ${Math.round(state.tickSpeedMs / 1000)}s/day` : ""}. ` +
        `Policies: ${pol || "none"}.`;
    }

    // Disable action buttons based on feasibility
    document.querySelectorAll("button[data-action]").forEach((btn) => {
      const key = btn.getAttribute("data-action");
      const over = state.gameOver;

      if (key === "buildFarm") btn.disabled = over || state.wood < CONFIG.FARM_WOOD_COST;
      else if (key === "feast") btn.disabled = over || state.food < 20;
      else btn.disabled = over;
    });

    // Toggle tick label
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
  // Wiring: sliders + time controls + reset
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

    if (ui.wfTools) {
      ui.wfTools.addEventListener("input", () => {
        state.workersTools = Number(ui.wfTools.value);
        validateWorkforce();
        syncWorkforceUItoState();
        render();
      });
    }
  }

  function wireTimeControls() {
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

    if (ui.endDay) {
      ui.endDay.addEventListener("click", () => {
        if (state.gameOver) return;
        tick();
      });
    }

    document.querySelectorAll("[data-speed]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (state.gameOver) return;

        const ms = Number(btn.getAttribute("data-speed"));
        if (!Number.isFinite(ms) || ms <= 0) return;

        state.tickSpeedMs = ms;

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
      logLine("New run started (MPL-B Tools).", "");

      renderEvent();
      render();
      applyTimeControl();
    });
  }

  function wireModeHotkey() {
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

    logLine("New run started (MPL-B Tools).", "");
    renderEvent();
    render();
    applyTimeControl();
  }

  boot();
})();

