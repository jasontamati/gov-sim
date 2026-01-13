// Governance MPL v3
// Full rewrite of your JS with the requested improvements, keeping the same core architecture:
// state → tick() → render() + declarative events, but upgraded with:
// - Seeded RNG (deterministic runs by seed)
// - Split Mood vs Authority (Authority is regime legitimacy; Mood is public temperature)
// - Pressure tracks (Subsistence / Security / Extraction)
// - Depopulation (migration) distinct from deaths
// - Tick phases made explicit
// - Event system moved to data-driven table (no switch), weighted by conditions
// - Event UI uses delegation (no re-bind per render) and is deterministic
// - Cached action/preset/speed nodes (no querySelectorAll in every render)
// - Backwards-compatible with your existing HTML IDs; new IDs are optional

(() => {
  "use strict";

  // -------------------------------
  // DOM helpers
  // -------------------------------
  const $ = (id) => document.getElementById(id);

  const ui = {
    day: $("day"),
    statusBadge: $("statusBadge"),
    pop: $("pop"),
    food: $("food"),
    wood: $("wood"),
    tools: $("tools"),

    // old id: stab → now used for Mood display (backwards compatible)
    mood: $("mood") || $("stab"),
    authority: $("authority"), // optional id

    // optional pressure ids (any/all)
    pSubsistence: $("pSubsistence"),
    pSecurity: $("pSecurity"),
    pExtraction: $("pExtraction"),
    pressuresLine: $("pressuresLine"), // optional single-line debug

    rates: $("rates"),
    farms: $("farms"),
    farmsBld: $("farmsBld"),
    log: $("log"),
    eventBox: $("eventBox"),

    toggleTick: $("toggleTick"),
    reset: $("reset"),
    endDay: $("endDay"),

    // workforce sliders
    wfFood: $("wfFood"),
    wfWood: $("wfWood"),
    wfTools: $("wfTools"),
    wfFoodVal: $("wfFoodVal"),
    wfWoodVal: $("wfWoodVal"),
    wfToolsVal: $("wfToolsVal"),

    // optional extras (future-proof)
    season: $("season"),
    seed: $("seed"),
    treasury: $("treasury"),
    taxLevel: $("taxLevel"),
    soldiers: $("soldiers"),
    soldiersHome: $("soldiersHome"),
    soldiersAway: $("soldiersAway"),
  };

  // -------------------------------
  // Config
  // -------------------------------
  const CONFIG = {
    // Time control
    DEFAULT_MODE: "auto", // "auto" | "manual"
    DEFAULT_SPEED_MS: 5000,

    // Determinism
    DEFAULT_SEED: 1337,

    // Workforce production
    FOOD_PER_WORKER: 1.0,
    WOOD_PER_WORKER: 0.8,
    TOOLS_PER_WORKER: 0.35,

    // Buildings
    FARM_WOOD_COST: 30,
    FARM_FOOD_MULT_PER_FARM: 0.08,

    // Tools system
    TOOLS_SOFTCAP: 100,
    TOOLS_BONUS_PER_TOOL: 0.002,
    TOOLS_MIN_BONUS: 1.0,
    TOOLS_DECAY_FLAT: 1.0,
    TOOLS_DECAY_PER_POP: 0.05,

    // Consumption
    FOOD_CONSUMPTION_PER_POP: 1.0,
    RATION_CONSUMPTION_MULT: 0.75,
    FEAST_CONSUMPTION_MULT: 1.25,

    // Policies
    RATION_DAYS: 5,
    FEAST_DAYS: 3,

    // Mood / Authority
    MOOD_MAX: 100,
    MOOD_MIN: 0,
    AUTH_MAX: 100,
    AUTH_MIN: 0,

    // Starvation (A + B) — no hard guillotine now; authority/pressure cascade replaces it
    STARVATION_MOOD_LOSS_MULT: 0.15,
    STARVATION_MOOD_LOSS_MIN: 2,
    STARVATION_MOOD_LOSS_MAX: 18,
    STARVATION_DEATH_DEFICIT_RATIO: 0.8,

    // Starvation escalation memory
    STARVE_MOOD_MULT_PER_DAY: 0.08,
    STARVE_DEATH_MULT_PER_DAY: 0.05,
    STARVE_DEATH_MAX_PER_DAY_RATIO: 0.35,

    // Pressure system
    PRESSURE_MAX: 100,
    PRESSURE_MIN: 0,
    P_DECAY_BASE: 0.6, // daily decay when conditions allow
    P_DECAY_BAD_COND_MULT: 0.35, // decay slows under bad conditions
    P_SUBS_FROM_DEFICIT_MULT: 0.55, // deficit -> subsistence pressure
    P_SUBS_STREAK_MULT: 0.25, // starveDays multiplier into subsistence pressure
    P_SEC_FROM_LOW_MOOD_MULT: 0.12, // low mood pushes security pressure
    P_EXTR_FROM_POLICIES_MULT: 0.0, // reserved (tax later)
    P_SHOCK_FROM_DEATHS: 0.6, // deaths shock pressure (folded into subsistence/security via authority bleed)

    // Authority drift from pressures (deterministic)
    AUTH_BLEED_BASE: 0.25,
    AUTH_BLEED_PSUBS_MULT: 0.045,
    AUTH_BLEED_PSEC_MULT: 0.04,
    AUTH_BLEED_PEXTR_MULT: 0.03,
    AUTH_RECOVER_BASE: 0.25,
    AUTH_RECOVER_CAP: 85,

    // Mood drift (deterministic)
    MOOD_RECOVER_IF_WELL_FED_RATIO: 3, // food > pop*ratio => mood drifts up
    MOOD_DRIFT_UP: 0.6,
    MOOD_DRIFT_CAP: 85,
    MOOD_DRIFT_DOWN_IF_TOO_HIGH: 0.2,
    MOOD_TOO_HIGH: 90,

    // Depopulation (migration) — distinct from deaths
    MIGRATION_MIN_POP: 6, // below this, effectively abandoned
    MIGRATION_TRIGGER_PSUBS: 55,
    MIGRATION_TRIGGER_PSEC: 55,
    MIGRATION_TRIGGER_MOOD: 35,
    MIGRATION_STREAK_START: 3,
    MIGRATION_PER_DAY_MIN: 1,
    MIGRATION_PER_DAY_MAX_RATIO: 0.08, // 8% pop/day cap
    MIGRATION_STREAK_MULT: 0.12, // increases migration with streak

    // Events
    EVENT_BASE_CHANCE: 0.05,
    EVENT_LOW_MOOD_BONUS: 0.10,
    EVENT_HIGH_PSUBS_BONUS: 0.12,
    EVENT_HIGH_PSEC_BONUS: 0.10,
    EVENT_LOW_MOOD_THRESHOLD: 35,
    EVENT_HIGH_P_THRESHOLD: 55,

    // Win/Lose
    WIN_DAY: 50,

    // Presets (workforce split ratios)
    PRESETS: {
      maxFood: { food: 1.0, wood: 0.0, tools: 0.0 },
      maxWood: { food: 0.0, wood: 1.0, tools: 0.0 },
      balanced: { food: 0.55, wood: 0.3, tools: 0.15 },
      survival: { food: 0.75, wood: 0.2, tools: 0.05 },
    },

    // Rates UI mode
    RATES_NET_FIRST: true,
  };

  // -------------------------------
  // Seeded RNG (deterministic)
  // -------------------------------
  function hashSeed(strOrNum) {
    // Simple deterministic hash to uint32
    const s = String(strOrNum ?? "");
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function mulberry32(seedU32) {
    let a = seedU32 >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // -------------------------------
  // State
  // -------------------------------
  const INITIAL = (seed = CONFIG.DEFAULT_SEED) => {
    const seedU32 = hashSeed(seed);
    return {
      // timeline
      day: 1,
      mode: CONFIG.DEFAULT_MODE,
      paused: false,
      gameOver: false,
      win: false,

      // determinism
      seed: seedU32,
      rngState: seedU32, // for display; actual RNG derived per tick from rngState
      // NOTE: we update rngState deterministically by consuming RNG draws in fixed order

      // core resources
      pop: 30,
      food: 80,
      wood: 40,
      tools: 10,

      // governance meters
      mood: 70,      // public temperature (short-term)
      authority: 70, // regime legitimacy (loss condition)

      // pressures (0–100)
      pSubsistence: 0,
      pSecurity: 0,
      pExtraction: 0,

      // memory
      starveDays: 0,
      depopStreak: 0,

      // workforce (labor pool competes with population only; soldiers can later reduce labor)
      workersFood: 10,
      workersWood: 5,
      workersTools: 0,

      // buildings
      farms: 0,

      // policies
      rationing: 0,
      feasting: 0,

      // event
      activeEvent: null,

      // tick timer
      tickSpeedMs: CONFIG.DEFAULT_SPEED_MS,
    };
  };

  let state = INITIAL(CONFIG.DEFAULT_SEED);

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
    // Status badge reflects MOOD (public temperature), not authority
    if (state.gameOver) return { text: state.win ? "VICTORY" : "GAME OVER", tone: state.win ? "good" : "bad" };
    if (state.mood >= 75) return { text: "Stable", tone: "good" };
    if (state.mood >= 40) return { text: "Tense", tone: "warn" };
    return { text: "Unstable", tone: "bad" };
  }

  // -------------------------------
  // Deterministic RNG per-tick
  // -------------------------------
  function makeRng() {
    // Derive an RNG from current rngState; update rngState deterministically by advancing
    // We can't “peek” without consuming; keep draw order stable.
    const rng = mulberry32(state.rngState >>> 0);
    function next() {
      const r = rng();
      // advance rngState deterministically by hashing the float bits-ish
      // (not cryptographic; just stable). Another option would be splitmix64,
      // but this is sufficient for deterministic gameplay.
      state.rngState = hashSeed((state.rngState ^ (r * 1e9)) >>> 0);
      return r;
    }
    function int(min, max) {
      return Math.floor(next() * (max - min + 1)) + min;
    }
    return { next, int };
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

  // Workforce clamping with priority: keep the slider the user changed
  function validateWorkforce(priorityKey = null) {
    const keys = ["workersFood", "workersWood", "workersTools"];
    for (const k of keys) state[k] = clamp(state[k], 0, state.pop);

    const total = state.workersFood + state.workersWood + state.workersTools;
    if (total <= state.pop) return;

    let overflow = total - state.pop;
    const clampOrder = keys.slice();
    if (priorityKey && clampOrder.includes(priorityKey)) {
      clampOrder.splice(clampOrder.indexOf(priorityKey), 1);
      clampOrder.push(priorityKey);
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
  // Event system (data-driven + deterministic)
  // -------------------------------
  function canAfford(cost = {}) {
    if (cost.food && state.food < cost.food) return false;
    if (cost.wood && state.wood < cost.wood) return false;
    if (cost.tools && state.tools < cost.tools) return false;
    return true;
  }

  function payCost(cost = {}) {
    if (cost.food) state.food -= cost.food;
    if (cost.wood) state.wood -= cost.wood;
    if (cost.tools) state.tools -= cost.tools;
    state.food = clamp(state.food, 0, 999999);
    state.wood = clamp(state.wood, 0, 999999);
    state.tools = clamp(state.tools, 0, 999999);
  }

  function applyEffects(effects = {}) {
    if (effects.food) state.food += effects.food;
    if (effects.wood) state.wood += effects.wood;
    if (effects.tools) state.tools += effects.tools;

    if (effects.mood) state.mood = clamp(state.mood + effects.mood, CONFIG.MOOD_MIN, CONFIG.MOOD_MAX);
    if (effects.authority) state.authority = clamp(state.authority + effects.authority, CONFIG.AUTH_MIN, CONFIG.AUTH_MAX);

    if (effects.pSubsistence) state.pSubsistence = clamp(state.pSubsistence + effects.pSubsistence, CONFIG.PRESSURE_MIN, CONFIG.PRESSURE_MAX);
    if (effects.pSecurity) state.pSecurity = clamp(state.pSecurity + effects.pSecurity, CONFIG.PRESSURE_MIN, CONFIG.PRESSURE_MAX);
    if (effects.pExtraction) state.pExtraction = clamp(state.pExtraction + effects.pExtraction, CONFIG.PRESSURE_MIN, CONFIG.PRESSURE_MAX);
  }

  const EVENTS = {
    TRADERS: {
      key: "TRADERS",
      title: "Wandering Traders Arrive",
      body: "They offer food for wood. A fair deal—but your stores matter.",
      weight: () => 1.0,
      options: [
        {
          label: "Trade 20 wood → 35 food",
          can: () => canAfford({ wood: 20 }),
          run: () => {
            payCost({ wood: 20 });
            applyEffects({ food: 35, mood: +2, authority: +1 });
            logLine("You traded with the traders. Supplies improved.", "good");
          },
        },
        {
          label: "Refuse",
          can: () => true,
          run: () => {
            applyEffects({ mood: -1 });
            logLine("You refused the traders.", "");
          },
        },
      ],
    },

    THEFT: {
      key: "THEFT",
      title: "Food Theft at Night",
      body: "Hungry citizens stole from stores. You must respond.",
      weight: () => (state.pSubsistence >= CONFIG.EVENT_HIGH_P_THRESHOLD ? 1.2 : 0.6),
      options: [
        {
          label: "Punish harshly (order now, legitimacy risk)",
          can: () => true,
          run: () => {
            const rng = makeRng();
            applyEffects({ mood: +4, authority: +3, pSecurity: -6 });
            if (rng.next() < 0.35) {
              state.pop = clamp(state.pop - 1, 0, 999999);
              applyEffects({ mood: -2, authority: -2, pSubsistence: +2 });
              logLine("Harsh punishment restored order—at a human cost.", "warn");
            } else {
              logLine("Harsh punishment restored order.", "warn");
            }
          },
        },
        {
          label: "Show mercy (authority down)",
          can: () => true,
          run: () => {
            applyEffects({ authority: -6, mood: -2, food: -6, pSecurity: +4 });
            logLine("Mercy preserved lives but weakened authority.", "bad");
          },
        },
      ],
    },

    RIOT: {
      key: "RIOT",
      title: "Public Riot",
      body: "Crowds gather—angry, scared. This can spiral.",
      weight: () => (state.pSecurity >= CONFIG.EVENT_HIGH_P_THRESHOLD ? 1.2 : 0.7),
      options: [
        {
          label: "Spend 25 food to calm them",
          can: () => canAfford({ food: 25 }),
          run: () => {
            payCost({ food: 25 });
            applyEffects({ mood: +10, authority: +6, pSecurity: -10, pSubsistence: -6 });
            logLine("You defused the riot with emergency supplies.", "good");
          },
        },
        {
          label: "Use force (can backfire)",
          can: () => true,
          run: () => {
            const rng = makeRng();
            applyEffects({ mood: +3, authority: +4, pSecurity: -5 });
            if (rng.next() < 0.5) {
              const loss = rng.int(5, 18);
              state.wood = clamp(state.wood - loss, 0, 999999);
              applyEffects({ mood: -7, authority: -5, pSecurity: +6 });
              logLine(`Force backfired: property damage (-${loss} wood).`, "bad");
            } else {
              logLine("Force ended the riot quickly.", "warn");
            }
          },
        },
      ],
    },

    COUP_WHISPERS: {
      key: "COUP_WHISPERS",
      title: "Whispers of a Coup",
      body: "Elites doubt your mandate. They watch for weakness.",
      weight: () => {
        // More likely when authority is low or pressures are high
        const a = 1 + (50 - state.authority) * 0.03;
        const p = 1 + (state.pSubsistence + state.pSecurity) * 0.004;
        return clamp(a * p, 0.2, 2.2);
      },
      options: [
        {
          label: "Concessions (mood up, authority mixed)",
          can: () => true,
          run: () => {
            applyEffects({ mood: +6, authority: -2, pExtraction: +4 });
            logLine("Concessions eased tension but signaled weakness.", "warn");
          },
        },
        {
          label: "Purge plotters (authority up, mood down)",
          can: () => true,
          run: () => {
            applyEffects({ authority: +6, mood: -6, pSecurity: +5 });
            logLine("You purged plotters. Control rose; fear spread.", "warn");
          },
        },
      ],
    },
  };

  function computeEventChance() {
    let chance = CONFIG.EVENT_BASE_CHANCE;

    if (state.mood < CONFIG.EVENT_LOW_MOOD_THRESHOLD) chance += CONFIG.EVENT_LOW_MOOD_BONUS;
    if (state.pSubsistence >= CONFIG.EVENT_HIGH_P_THRESHOLD) chance += CONFIG.EVENT_HIGH_PSUBS_BONUS;
    if (state.pSecurity >= CONFIG.EVENT_HIGH_P_THRESHOLD) chance += CONFIG.EVENT_HIGH_PSEC_BONUS;

    // Clamp to sensible range
    return clamp(chance, 0, 0.65);
  }

  function pickWeightedEvent(keys, rng) {
    // deterministic weighted pick
    let total = 0;
    const weights = keys.map((k) => {
      const w = clamp(EVENTS[k]?.weight?.() ?? 0, 0, 5);
      total += w;
      return w;
    });
    if (total <= 0) return null;

    let roll = rng.next() * total;
    for (let i = 0; i < keys.length; i++) {
      roll -= weights[i];
      if (roll <= 0) return keys[i];
    }
    return keys[keys.length - 1];
  }

  function maybeTriggerEvent() {
    if (state.activeEvent || state.gameOver) return;

    const rng = makeRng();
    const chance = computeEventChance();
    if (rng.next() > chance) return;

    // Build pool deterministically by conditions
    const pool = ["TRADERS"];

    if (state.pSubsistence >= CONFIG.EVENT_HIGH_P_THRESHOLD) pool.push("THEFT");
    if (state.pSecurity >= CONFIG.EVENT_HIGH_P_THRESHOLD || state.mood < CONFIG.EVENT_LOW_MOOD_THRESHOLD) pool.push("RIOT");
    if (state.authority < 45 || (state.pSubsistence + state.pSecurity) > 110) pool.push("COUP_WHISPERS");

    const pick = pickWeightedEvent(pool, rng);
    if (!pick) return;

    state.activeEvent = pick;
    renderEvent();
  }

  function resolveEvent(optionIndex) {
    if (!state.activeEvent) return;
    const ev = EVENTS[state.activeEvent];
    if (!ev) return;

    const opt = ev.options?.[optionIndex];
    if (!opt || !opt.can()) return;

    opt.run();
    state.activeEvent = null;
    renderEvent();
    render();
  }

  // -------------------------------
  // Player actions
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
      // Farms improve subsistence confidence slightly
      applyEffects({ mood: +2, authority: +1, pSubsistence: -2 });
      logLine("Built a farm. Food output will scale better.", "good");
    },

    ration: () => {
      state.rationing = CONFIG.RATION_DAYS;
      state.feasting = 0;
      // Rationing: mood down, authority slight up (discipline), subsistence pressure may ease (less consumption)
      applyEffects({ mood: -6, authority: +1, pSecurity: +2 });
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
      applyEffects({ mood: +8, authority: +2, pSubsistence: -3 });
      logLine(`Feast declared for ${CONFIG.FEAST_DAYS} days.`, "good");
    },
  };

  // -------------------------------
  // Tick phases
  // -------------------------------
  function phaseValidate() {
    validateWorkforce(null);
  }

  function phasePolicyTimers() {
    if (state.rationing > 0) state.rationing -= 1;
    if (state.feasting > 0) state.feasting -= 1;
  }

  function phaseProduction() {
    const fp = foodPerDay();
    const wp = woodPerDay();
    const tp = toolsPerDay();

    state.food += fp;
    state.wood += wp;
    state.tools += tp;
  }

  function phaseMaintenance() {
    state.tools = clamp(state.tools - toolsDecayPerDay(), 0, 999999);
  }

  function phaseConsumption() {
    const cons = foodConsumptionPerDay();
    state.food -= cons;

    // return deficit if any
    if (state.food < 0) {
      const deficit = Math.abs(state.food);
      state.food = 0;
      return deficit;
    }
    return 0;
  }

  function phaseStarvation(deficit) {
    if (deficit <= 0) {
      state.starveDays = 0;
      return { deaths: 0, moodLoss: 0 };
    }

    state.starveDays += 1;

    // Mood loss escalates with streak
    const moodMult = 1 + state.starveDays * CONFIG.STARVE_MOOD_MULT_PER_DAY;
    const baseMoodLoss = clamp(
      deficit * CONFIG.STARVATION_MOOD_LOSS_MULT,
      CONFIG.STARVATION_MOOD_LOSS_MIN,
      CONFIG.STARVATION_MOOD_LOSS_MAX
    );
    const moodLoss = clamp(
      baseMoodLoss * moodMult,
      CONFIG.STARVATION_MOOD_LOSS_MIN,
      CONFIG.STARVATION_MOOD_LOSS_MAX
    );
    state.mood = clamp(state.mood - moodLoss, CONFIG.MOOD_MIN, CONFIG.MOOD_MAX);

    // Deaths: proportional to unfed, escalates with streak, capped per day
    const unfed = Math.ceil(deficit / CONFIG.FOOD_CONSUMPTION_PER_POP);
    const deathMult = 1 + state.starveDays * CONFIG.STARVE_DEATH_MULT_PER_DAY;
    const rawDeaths = Math.floor(unfed * deathMult);
    const maxDeaths = Math.max(1, Math.floor(state.pop * CONFIG.STARVE_DEATH_MAX_PER_DAY_RATIO));
    const deaths = clamp(rawDeaths, 1, maxDeaths);

    // Only lethal if deficit is serious relative to pop
    if (deficit > state.pop * CONFIG.STARVATION_DEATH_DEFICIT_RATIO) {
      state.pop = clamp(state.pop - deaths, 0, 999999);
      logLine(`Starvation killed ${deaths} people. (streak: ${state.starveDays}d)`, "bad");
      return { deaths, moodLoss };
    } else {
      logLine(`Food shortage reduced mood. (streak: ${state.starveDays}d)`, "warn");
      return { deaths: 0, moodLoss };
    }
  }

  function phasePressures(deficit, starvationOutcome) {
    // Determine “bad conditions”
    const isHungry = deficit > 0;
    const wellFed = state.food > state.pop * CONFIG.MOOD_RECOVER_IF_WELL_FED_RATIO;

    // Subsistence pressure from deficit + streak
    if (isHungry) {
      const add =
        deficit * CONFIG.P_SUBS_FROM_DEFICIT_MULT +
        state.starveDays * CONFIG.P_SUBS_STREAK_MULT;
      state.pSubsistence = clamp(state.pSubsistence + add, CONFIG.PRESSURE_MIN, CONFIG.PRESSURE_MAX);
    } else {
      // mild subsistence relief when stable
      state.pSubsistence = clamp(state.pSubsistence - CONFIG.P_DECAY_BASE * (wellFed ? 1.15 : 1.0), CONFIG.PRESSURE_MIN, CONFIG.PRESSURE_MAX);
    }

    // Security pressure rises if mood is low (unrest propensity)
    if (state.mood < 50) {
      const add = (50 - state.mood) * CONFIG.P_SEC_FROM_LOW_MOOD_MULT;
      state.pSecurity = clamp(state.pSecurity + add, CONFIG.PRESSURE_MIN, CONFIG.PRESSURE_MAX);
    } else {
      state.pSecurity = clamp(state.pSecurity - CONFIG.P_DECAY_BASE, CONFIG.PRESSURE_MIN, CONFIG.PRESSURE_MAX);
    }

    // Extraction pressure (reserved; decays slowly for now)
    state.pExtraction = clamp(state.pExtraction - (CONFIG.P_DECAY_BASE * 0.5), CONFIG.PRESSURE_MIN, CONFIG.PRESSURE_MAX);

    // Shock from deaths (fold into subsistence/security)
    if (starvationOutcome.deaths > 0) {
      const shock = starvationOutcome.deaths * CONFIG.P_SHOCK_FROM_DEATHS;
      state.pSubsistence = clamp(state.pSubsistence + shock * 0.6, CONFIG.PRESSURE_MIN, CONFIG.PRESSURE_MAX);
      state.pSecurity = clamp(state.pSecurity + shock * 0.4, CONFIG.PRESSURE_MIN, CONFIG.PRESSURE_MAX);
    }

    // Under bad conditions, pressure decay should slow (handled implicitly above)
    // Keep this function deterministic and free of RNG.
  }

  function phaseAuthorityMoodDrift() {
    // Mood drift (planning-friendly): well-fed improves mood, too-high mood drifts down
    if (state.food > state.pop * CONFIG.MOOD_RECOVER_IF_WELL_FED_RATIO && state.mood < CONFIG.MOOD_DRIFT_CAP) {
      state.mood = clamp(state.mood + CONFIG.MOOD_DRIFT_UP, CONFIG.MOOD_MIN, CONFIG.MOOD_MAX);
    }
    if (state.mood > CONFIG.MOOD_TOO_HIGH) {
      state.mood = clamp(state.mood - CONFIG.MOOD_DRIFT_DOWN_IF_TOO_HIGH, CONFIG.MOOD_MIN, CONFIG.MOOD_MAX);
    }

    // Authority drift from pressures (primary governance loss condition)
    const pressureBleed =
      CONFIG.AUTH_BLEED_BASE +
      state.pSubsistence * CONFIG.AUTH_BLEED_PSUBS_MULT +
      state.pSecurity * CONFIG.AUTH_BLEED_PSEC_MULT +
      state.pExtraction * CONFIG.AUTH_BLEED_PEXTR_MULT;

    // Recovery if pressures are low and mood isn't collapsing
    const pressuresLow = (state.pSubsistence + state.pSecurity + state.pExtraction) < 45;
    const canRecover = pressuresLow && state.mood >= 45 && state.authority < CONFIG.AUTH_RECOVER_CAP;

    if (canRecover) {
      state.authority = clamp(state.authority + CONFIG.AUTH_RECOVER_BASE, CONFIG.AUTH_MIN, CONFIG.AUTH_MAX);
    } else {
      state.authority = clamp(state.authority - pressureBleed, CONFIG.AUTH_MIN, CONFIG.AUTH_MAX);
    }
  }

  function phaseDepopulation() {
    // Depopulation as migration, not death
    const badSubs = state.pSubsistence >= CONFIG.MIGRATION_TRIGGER_PSUBS;
    const badSec = state.pSecurity >= CONFIG.MIGRATION_TRIGGER_PSEC;
    const lowMood = state.mood <= CONFIG.MIGRATION_TRIGGER_MOOD;

    if (badSubs && badSec && lowMood) state.depopStreak += 1;
    else state.depopStreak = 0;

    if (state.depopStreak < CONFIG.MIGRATION_STREAK_START) return;

    // Migration amount escalates with streak, capped
    const cap = Math.max(CONFIG.MIGRATION_PER_DAY_MIN, Math.floor(state.pop * CONFIG.MIGRATION_PER_DAY_MAX_RATIO));
    const base = CONFIG.MIGRATION_PER_DAY_MIN;
    const extra = Math.floor(state.pop * (state.depopStreak * CONFIG.MIGRATION_STREAK_MULT));
    const leaving = clamp(base + extra, CONFIG.MIGRATION_PER_DAY_MIN, cap);

    if (leaving > 0 && state.pop > 0) {
      state.pop = clamp(state.pop - leaving, 0, 999999);
      // Migration tends to reduce security and authority (loss of faith / hollowing out)
      state.mood = clamp(state.mood - 1.5, CONFIG.MOOD_MIN, CONFIG.MOOD_MAX);
      state.authority = clamp(state.authority - 1.0, CONFIG.AUTH_MIN, CONFIG.AUTH_MAX);
      logLine(`Migration: ${leaving} people left the settlement. (streak: ${state.depopStreak}d)`, "warn");
    }
  }

  function phaseEvents() {
    maybeTriggerEvent();
  }

  function phaseEndChecks() {
    if (state.pop <= 0) return endGame("Population collapsed.");
    if (state.pop <= CONFIG.MIGRATION_MIN_POP) return endGame("The settlement was abandoned.");
    if (state.authority <= 0) return endGame("Authority collapsed. You were removed from power.");
    if (state.day >= CONFIG.WIN_DAY) return endGame(`You survived ${CONFIG.WIN_DAY} days. MPL complete.`, true);
    return null;
  }

  // -------------------------------
  // Tick (1 day)
  // -------------------------------
  function tick() {
    if (state.gameOver) return;
    if (state.paused && state.mode === "auto") return;

    // 1) Validate workforce
    phaseValidate();

    // 2) Policy timers
    phasePolicyTimers();

    // 3) Production
    phaseProduction();

    // 4) Maintenance / decay
    phaseMaintenance();

    // 5) Consumption → deficit
    const deficit = phaseConsumption();

    // 6) Starvation (mood + possibly deaths)
    const starvationOutcome = phaseStarvation(deficit);

    // 7) Pressure update (subsistence / security / extraction)
    phasePressures(deficit, starvationOutcome);

    // 8) Authority + mood drift (derived, deterministic)
    phaseAuthorityMoodDrift();

    // 9) Depopulation (migration)
    phaseDepopulation();

    // 10) Events
    phaseEvents();

    // 11) End checks (authority now governs regime loss)
    const ended = phaseEndChecks();
    if (ended) return;

    // 12) Advance time
    state.day += 1;

    // 13) Render
    render();
  }

  function endGame(reason, win = false) {
    state.gameOver = true;
    state.win = !!win;
    logLine(reason, win ? "good" : "bad");
    applyTimeControl();
    render();
  }

  // -------------------------------
  // Render
  // -------------------------------
  function renderEvent() {
    if (!ui.eventBox) return;

    const key = state.activeEvent;
    if (!key) {
      ui.eventBox.className = "event empty";
      ui.eventBox.innerHTML = `
        <div class="event-title">No active event</div>
        <div class="event-body">Keep the settlement alive.</div>
      `;
      return;
    }

    const ev = EVENTS[key];
    if (!ev) {
      ui.eventBox.className = "event empty";
      ui.eventBox.innerHTML = `
        <div class="event-title">No active event</div>
        <div class="event-body">Keep the settlement alive.</div>
      `;
      state.activeEvent = null;
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

  function renderRates() {
    if (!ui.rates) return;

    const fp = foodPerDay();
    const wp = woodPerDay();
    const tp = toolsPerDay();
    const cons = foodConsumptionPerDay();
    const toolMult = toolsBonusMult();
    const decay = toolsDecayPerDay();

    const netFood = fp - cons;
    const netWood = wp;
    const netTools = tp - decay;

    const pol = [
      state.rationing > 0 ? `Rationing(${state.rationing}d)` : null,
      state.feasting > 0 ? `Feast(${state.feasting}d)` : null,
    ].filter(Boolean).join(" ");

    const hunger = `Hunger(${state.starveDays}d)`;
    const depop = state.depopStreak > 0 ? `Depop(${state.depopStreak}d)` : `Depop(0d)`;

    if (CONFIG.RATES_NET_FIRST) {
      const foodClass = netFood >= 0 ? "good" : "bad";
      const toolsClass = netTools >= 0 ? "good" : "warn";

      ui.rates.innerHTML =
        `<div class="ratesTop">
          <span class="pill ${foodClass}">Net Food: ${netFood.toFixed(1)}/day</span>
          <span class="pill">Wood: +${netWood.toFixed(1)}/day</span>
          <span class="pill ${toolsClass}">Net Tools: ${netTools.toFixed(1)}/day</span>
        </div>
        <div class="ratesBottom">
          Food: +${fp.toFixed(1)} -${cons.toFixed(1)} ·
          Tools: ×${toolMult.toFixed(2)} (-${decay.toFixed(1)}) ·
          Mode: ${state.mode}${state.mode === "auto" ? ` @ ${Math.round(state.tickSpeedMs / 1000)}s/day` : ""} ·
          Policies: ${pol || "none"} ·
          ${hunger} · ${depop}
        </div>`;
    } else {
      ui.rates.textContent =
        `Net: ${netFood.toFixed(1)} food/day, +${netWood.toFixed(1)} wood/day, ${netTools.toFixed(1)} tools/day. ` +
        `Food: +${fp.toFixed(1)} -${cons.toFixed(1)}. ` +
        `Tools: ×${toolMult.toFixed(2)} (-${decay.toFixed(1)}/day). ` +
        `Mode: ${state.mode}${state.mode === "auto" ? ` @ ${Math.round(state.tickSpeedMs / 1000)}s/day` : ""}. ` +
        `Policies: ${pol || "none"}. Hunger(${state.starveDays}d). Depop(${state.depopStreak}d).`;
    }
  }

  function renderPressures() {
    // Priority: dedicated IDs if present; fallback to single line if present
    const ps = fmtInt(state.pSubsistence);
    const psec = fmtInt(state.pSecurity);
    const pex = fmtInt(state.pExtraction);

    if (ui.pSubsistence) ui.pSubsistence.textContent = ps;
    if (ui.pSecurity) ui.pSecurity.textContent = psec;
    if (ui.pExtraction) ui.pExtraction.textContent = pex;

    if (ui.pressuresLine) {
      ui.pressuresLine.textContent = `Pressure — Subs:${ps} Sec:${psec} Extr:${pex}`;
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

    // Mood display (backwards compatible with #stab)
    if (ui.mood) ui.mood.textContent = `${fmtInt(state.mood)} / ${CONFIG.MOOD_MAX}`;

    // Authority display (optional)
    if (ui.authority) ui.authority.textContent = `${fmtInt(state.authority)} / ${CONFIG.AUTH_MAX}`;

    // Farms dual render supported
    if (ui.farms) ui.farms.textContent = fmtInt(state.farms);
    if (ui.farmsBld) ui.farmsBld.textContent = fmtInt(state.farms);

    // Seed display (optional)
    if (ui.seed) ui.seed.textContent = String(state.seed >>> 0);

    renderPressures();
    renderRates();

    // Disable/enable action buttons (cached)
    for (const btn of cached.actionButtons) {
      const key = btn.getAttribute("data-action");
      const over = state.gameOver;

      if (key === "buildFarm") btn.disabled = over || state.wood < CONFIG.FARM_WOOD_COST;
      else if (key === "feast") btn.disabled = over || state.food < 20;
      else btn.disabled = over;
    }

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
    renderEvent();
  }

  // -------------------------------
  // Wiring (cached nodes + delegation)
  // -------------------------------
  const cached = {
    actionButtons: [],
    presetButtons: [],
    speedButtons: [],
  };

  function cacheUiNodes() {
    cached.actionButtons = Array.from(document.querySelectorAll("button[data-action]"));
    cached.presetButtons = Array.from(document.querySelectorAll("button[data-preset]"));
    cached.speedButtons = Array.from(document.querySelectorAll("[data-speed]"));
  }

  function wireActionButtons() {
    for (const btn of cached.actionButtons) {
      btn.addEventListener("click", () => {
        if (state.gameOver) return;
        const key = btn.getAttribute("data-action");
        const fn = actions[key];
        if (typeof fn !== "function") return;
        fn();
        render();
      });
    }
  }

  function wirePresetButtons() {
    for (const btn of cached.presetButtons) {
      btn.addEventListener("click", () => {
        if (state.gameOver) return;
        const key = btn.getAttribute("data-preset");
        applyPreset(key);
        syncWorkforceUItoState();
        render();
      });
    }
  }

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

  function wireEventBoxDelegation() {
    if (!ui.eventBox) return;
    ui.eventBox.addEventListener("click", (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      const idx = t.getAttribute("data-ev");
      if (idx === null) return;
      if (state.gameOver) return;
      resolveEvent(Number(idx));
    });
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

    for (const btn of cached.speedButtons) {
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
    }
  }

  function wireReset() {
    if (!ui.reset) return;

    ui.reset.addEventListener("click", () => {
      stopAutoTick();
      // Keep same seed for reproducibility unless you change CONFIG.DEFAULT_SEED
      const seedToUse = state.seed >>> 0;
      state = INITIAL(seedToUse);

      if (ui.log) ui.log.innerHTML = "";
      logLine(`New run started. Seed: ${state.seed >>> 0}`, "");

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
    cacheUiNodes();
    wireActionButtons();
    wirePresetButtons();
    wireWorkforceSliders();
    wireEventBoxDelegation();
    wireTimeControls();
    wireReset();
    wireModeHotkey();

    logLine(`New run started. Seed: ${state.seed >>> 0}`, "");
    render();
    applyTimeControl();
  }

  boot();
})();
