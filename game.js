// Governance MPL - deterministic loop + manual/auto time + declarative events
// Version upgrades in this rewrite:
// - Tools is a real system: workforce -> tools production, tools decay, tools boost output
// - wfTools slider support + tools stat rendering
// - farms duplicate display supported: #farms (state) + #farmsBld (buildings panel)
// - Workforce clamping prioritizes the slider the user changed (no "slider fight")
// - Preset buttons (data-preset): maxFood, maxWood, balanced, survival
// - Starvation model upgraded to A + B + C:
//     A) proportional deaths based on deficit (unfed people)
//     B) escalating penalties via consecutive hungry days (starveDays)
//     C) hard fail after STARVE_DAYS_GAMEOVER consecutive hungry days
// - tick() remains deterministic in structure (no DOM reads), actions mutate state, render presents state

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
    tools: $("tools"),
    stab: $("stab"),
    rates: $("rates"),
    farms: $("farms"),
    farmsBld: $("farmsBld"),
    log: $("log"),
    eventBox: $("eventBox"),

    toggleTick: $("toggleTick"),
    reset: $("reset"),
    endDay: $("endDay"), // optional (present in your HTML)

    wfFood: $("wfFood"),
    wfWood: $("wfWood"),
    wfTools: $("wfTools"),
    wfFoodVal: $("wfFoodVal"),
    wfWoodVal: $("wfWoodVal"),
    wfToolsVal: $("wfToolsVal"),
  };

  // -------------------------------
  // Constants (tune here)
  // -------------------------------
  const CONFIG = {
    // Time control
    DEFAULT_MODE: "auto", // "auto" | "manual"
    DEFAULT_SPEED_MS: 5000, // 1 day = 5 seconds (auto mode)

    // Workforce production
    FOOD_PER_WORKER: 1.0,
    WOOD_PER_WORKER: 0.8,
    TOOLS_PER_WORKER: 0.35,

    // Buildings
    FARM_WOOD_COST: 30,
    FARM_FOOD_MULT_PER_FARM: 0.08, // +8% food output per farm

    // Tools system
    TOOLS_SOFTCAP: 100, // beyond this gives no extra bonus
    TOOLS_BONUS_PER_TOOL: 0.002, // 100 tools -> +20% output
    TOOLS_MIN_BONUS: 1.0,
    TOOLS_DECAY_FLAT: 1.0, // lose at least this much tools per day
    TOOLS_DECAY_PER_POP: 0.05, // plus pop*X per day, models wear & maintenance

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

    // Starvation penalties (baseline)
    STARVATION_STAB_LOSS_MULT: 0.15, // per missing food unit
    STARVATION_STAB_LOSS_MIN: 2,
    STARVATION_STAB_LOSS_MAX: 18,
    STARVATION_DEATH_DEFICIT_RATIO: 0.8, // only lethal if deficit is "serious" vs pop

    // Starvation escalation + collapse (A + B + C)
    STARVE_DAYS_GAMEOVER: 15, // C: hard fail after 15 consecutive hungry days
    STARVE_STAB_MULT_PER_DAY: 0.08, // B: +8% stab loss per hungry day
    STARVE_DEATH_MULT_PER_DAY: 0.05, // B: +5% deaths per hungry day
    STARVE_DEATH_MAX_PER_DAY_RATIO: 0.35, // cap deaths/day to avoid instant wipeouts

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

    // Presets (workforce split ratios)
    PRESETS: {
      maxFood: { food: 1.0, wood: 0.0, tools: 0.0 },
      maxWood: { food: 0.0, wood: 1.0, tools: 0.0 },
      balanced: { food: 0.55, wood: 0.30, tools: 0.15 },
      survival: { food: 0.75, wood: 0.20, tools: 0.05 },
    },
  };

  // -------------------------------
  // State
  // -------------------------------
  const INITIAL = () => ({
    // timeline
    day: 1,
    mode: CONFIG.DEFAULT_MODE, // "auto" or "manual"
    paused: false,
    gameOver: false,

    // core resources
    pop: 30,
    food: 80,
    wood: 40,
    tools: 10,
    stability: 70,

    // workforce
    workersFood: 10,
    workersWood: 5,
    workersTools: 0,

    // buildings
    farms: 0,

    // policies (timers)
    rationing: 0,
    feasting: 0,

    // hunger memory
    starveDays: 0,

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
    return 1 + state.farms * CONFIG.FARM_FOOD_MULT_PER_FARM;
  }

  function toolsBonusMult() {
    const effectiveTools = clamp(state.tools, 0, CONFIG.TOOLS_SOFTCAP);
    const mult = 1 + effectiveTools * CONFIG.TOOLS_BONUS_PER_TOOL;
    return Math.max(CONFIG.TOOLS_MIN_BONUS, mult);
  }

  function foodPerDay() {
    return state.workersFood * CONFIG.FOOD_PER_WORKER * farmBonusMult() * toolsBonusMult();
  }

  function woodPerDay() {
    return state.workersWood * CONFIG.WOOD_PER_WORKER * toolsBonusMult();
  }

  function toolsPerDay() {
    return state.workersTools * CONFIG.TOOLS_PER_WORKER;
  }

  function toolsDecayPerDay() {
    return CONFIG.TOOLS_DECAY_FLAT + state.pop * CONFIG.TOOLS_DECAY_PER_POP;
  }

  function foodConsumptionPerDay() {
    let consumption = state.pop * CONFIG.FOOD_CONSUMPTION_PER_POP;
    if (state.rationing > 0) consumption *= CONFIG.RATION_CONSUMPTION_MULT;
    if (state.feasting > 0) consumption *= CONFIG.FEAST_CONSUMPTION_MULT;
    return consumption;
  }

  // Workforce clamping:
  // - Guarantee total workers <= population.
  // - Priority: keep the slider the user changed, clamp the others first.
  function validateWorkforce(priorityKey = null) {
    const keys = ["workersFood", "workersWood", "workersTools"];

    // Hard clamp each to [0, pop]
    for (const k of keys) state[k] = clamp(state[k], 0, state.pop);

    const total = state.workersFood + state.workersWood + state.workersTools;
    if (total <= state.pop) return;

    let overflow = total - state.pop;

    const clampOrder = keys.slice();
    if (priorityKey && clampOrder.includes(priorityKey)) {
      clampOrder.splice(clampOrder.indexOf(priorityKey), 1);
      clampOrder.push(priorityKey); // clamp priority last
    }

    for (const k of clampOrder) {
      if (overflow <= 0) break;
      const reducible = state[k];
      const d = Math.min(reducible, overflow);
      state[k] -= d;
      overflow -= d;
    }
  }

  // -------------------------------
  // Presets
  // -------------------------------
  function applyPreset(name) {
    const preset = CONFIG.PRESETS[name];
    if (!preset) return;

    const pop = state.pop;

    let f = Math.floor(pop * preset.food);
    let w = Math.floor(pop * preset.wood);
    let t = Math.floor(pop * preset.tools);

    f = Math.max(0, f);
    w = Math.max(0, w);
    t = Math.max(0, t);

    // Round to exactly pop with a deliberate priority order.
    let used = f + w + t;
    while (used < pop) {
      f += 1; used += 1;
      if (used >= pop) break;
      w += 1; used += 1;
      if (used >= pop) break;
      t += 1; used += 1;
    }
    while (used > pop) {
      if (t > 0) t -= 1;
      else if (w > 0) w -= 1;
      else if (f > 0) f -= 1;
      used = f + w + t;
    }

    state.workersFood = f;
    state.workersWood = w;
    state.workersTools = t;

    validateWorkforce(null);
    logLine(`Applied preset: ${name}.`, "");
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
              label: "Punish harshly (order now, risk deaths)",
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

  function wirePresetButtons() {
    document.querySelectorAll("button[data-preset]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (state.gameOver) return;
        const key = btn.getAttribute("data-preset");
        applyPreset(key);
        syncWorkforceUItoState();
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

    validateWorkforce(null);

    // Policy timers
    if (state.rationing > 0) state.rationing -= 1;
    if (state.feasting > 0) state.feasting -= 1;

    // Production
    const fp = foodPerDay();
    const wp = woodPerDay();
    const tp = toolsPerDay();

    state.food += fp;
    state.wood += wp;
    state.tools += tp;

    // Tools decay
    state.tools = clamp(state.tools - toolsDecayPerDay(), 0, 999999);

    // Consumption
    const cons = foodConsumptionPerDay();
    state.food -= cons;

    // ---------------------------
    // Starvation (A + B + C)
    // ---------------------------
    let deficit = 0;
    if (state.food < 0) {
      deficit = Math.abs(state.food);
      state.food = 0;
    }

    // Hunger memory
    if (deficit > 0) state.starveDays += 1;
    else state.starveDays = 0;

    if (deficit > 0) {
      const stabMult = 1 + state.starveDays * CONFIG.STARVE_STAB_MULT_PER_DAY;
      const deathMult = 1 + state.starveDays * CONFIG.STARVE_DEATH_MULT_PER_DAY;

      // Stability loss (escalates)
      const baseStabLoss = clamp(
        deficit * CONFIG.STARVATION_STAB_LOSS_MULT,
        CONFIG.STARVATION_STAB_LOSS_MIN,
        CONFIG.STARVATION_STAB_LOSS_MAX
      );
      const stabLoss = clamp(
        baseStabLoss * stabMult,
        CONFIG.STARVATION_STAB_LOSS_MIN,
        CONFIG.STARVATION_STAB_LOSS_MAX
      );
      state.stability = clamp(state.stability - stabLoss, CONFIG.STAB_MIN, CONFIG.STAB_MAX);

      // A: proportional deaths based on unfed people
      const unfed = Math.ceil(deficit / CONFIG.FOOD_CONSUMPTION_PER_POP);

      // Scale with streak, cap per day to keep gameplay readable
      const rawDeaths = Math.floor(unfed * deathMult);
      const maxDeaths = Math.max(1, Math.floor(state.pop * CONFIG.STARVE_DEATH_MAX_PER_DAY_RATIO));
      const deaths = clamp(rawDeaths, 1, maxDeaths);

      // Only lethal if deficit is serious relative to pop
      if (deficit > state.pop * CONFIG.STARVATION_DEATH_DEFICIT_RATIO) {
        state.pop = clamp(state.pop - deaths, 0, 999999);
        logLine(`Starvation killed ${deaths} people. (streak: ${state.starveDays}d)`, "bad");
      } else {
        logLine(`Food shortage reduced stability. (streak: ${state.starveDays}d)`, "warn");
      }

      // C: hard fail if famine lasts too long
      if (state.starveDays >= CONFIG.STARVE_DAYS_GAMEOVER) {
        return endGame(`Famine collapse: ${state.starveDays} consecutive hungry days.`);
      }
    }

    // Ambient drift
    if (
      state.food > state.pop * CONFIG.STAB_DRIFT_UP_IF_WELL_FED_RATIO &&
      state.stability < CONFIG.STAB_DRIFT_CAP
    ) {
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
    const popStr = String(state.pop);

    if (ui.wfFood) {
      ui.wfFood.max = popStr;
      ui.wfFood.value = String(state.workersFood);
      if (ui.wfFoodVal) ui.wfFoodVal.textContent = String(state.workersFood);
    }

    if (ui.wfWood) {
      ui.wfWood.max = popStr;
      ui.wfWood.value = String(state.workersWood);
      if (ui.wfWoodVal) ui.wfWoodVal.textContent = String(state.workersWood);
    }

    if (ui.wfTools) {
      ui.wfTools.max = popStr;
      ui.wfTools.value = String(state.workersTools);
      if (ui.wfToolsVal) ui.wfToolsVal.textContent = String(state.workersTools);
    }
  }

  function render() {
    const s = statusLabel();

    if (ui.day) ui.day.textContent = `Day ${state.day}`;

    if (ui.statusBadge) {
      ui.statusBadge.textContent = s.text;
      const color = s.tone === "good" ? "var(--good)" : s.tone === "warn" ? "var(--warn)" : "var(--bad)";
      ui.statusBadge.style.color = color;
      ui.statusBadge.style.borderColor = color;
    }

    if (ui.pop) ui.pop.textContent = fmtInt(state.pop);
    if (ui.food) ui.food.textContent = fmtInt(state.food);
    if (ui.wood) ui.wood.textContent = fmtInt(state.wood);
    if (ui.tools) ui.tools.textContent = fmtInt(state.tools);
    if (ui.stab) ui.stab.textContent = `${fmtInt(state.stability)} / ${CONFIG.STAB_MAX}`;

    if (ui.farms) ui.farms.textContent = fmtInt(state.farms);
    if (ui.farmsBld) ui.farmsBld.textContent = fmtInt(state.farms);

    if (ui.rates) {
      const fp = foodPerDay();
      const wp = woodPerDay();
      const tp = toolsPerDay();
      const cons = foodConsumptionPerDay();
      const toolMult = toolsBonusMult();
      const decay = toolsDecayPerDay();

      const pol = [
        state.rationing > 0 ? `Rationing(${state.rationing}d)` : null,
        state.feasting > 0 ? `Feast(${state.feasting}d)` : null,
      ]
        .filter(Boolean)
        .join(" ");

      const hunger = state.starveDays > 0 ? ` HungerStreak(${state.starveDays}d).` : "";

      ui.rates.textContent =
        `Rates: +${fp.toFixed(1)} food/day, +${wp.toFixed(1)} wood/day, +${tp.toFixed(1)} tools/day, ` +
        `-${cons.toFixed(1)} food/day consumption. ` +
        `Tools: ×${toolMult.toFixed(2)} output, -${decay.toFixed(1)}/day decay. ` +
        `Mode: ${state.mode}${state.mode === "auto" ? ` @ ${Math.round(state.tickSpeedMs / 1000)}s/day` : ""}. ` +
        `Policies: ${pol || "none"}.` +
        hunger;
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
        validateWorkforce("workersFood");
        syncWorkforceUItoState();
        render();
      });
    }

    if (ui.wfWood) {
      ui.wfWood.addEventListener("input", () => {
        state.workersWood = Number(ui.wfWood.value);
        validateWorkforce("workersWood");
        syncWorkforceUItoState();
        render();
      });
    }

    if (ui.wfTools) {
      ui.wfTools.addEventListener("input", () => {
        state.workersTools = Number(ui.wfTools.value);
        validateWorkforce("workersTools");
        syncWorkforceUItoState();
        render();
      });
    }
  }

  function wireTimeControls() {
    // ToggleTick behavior:
    // - If manual mode: toggles to auto mode and starts ticking.
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
    wirePresetButtons();
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
