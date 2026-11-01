import { RANKS, rankForXp } from "./ballistics";
import type { ContractState, MetaState, MissionStats, RewardReport } from "./types";

const STORAGE_KEY = "neon-rift.aftermath.v1";
const SETTINGS_KEY = "neon-rift.settings.v1";

export const CONTRACTS: ReadonlyArray<{
  id: string;
  label: string;
  detail: string;
  check: (stats: MissionStats) => boolean;
}> = [
  {
    id: "first_light",
    label: "First Light",
    detail: "Complete any contract.",
    check: (stats) => stats.success,
  },
  {
    id: "clean_run",
    label: "Clean Run",
    detail: "Extract without losing a squadmate.",
    check: (stats) => stats.success && stats.alliesLost === 0,
  },
  {
    id: "headhunter",
    label: "Headhunter",
    detail: "Land 3 headshots and extract.",
    check: (stats) => stats.success && stats.headshots >= 3,
  },
  {
    id: "ghost_protocol",
    label: "Ghost Protocol",
    detail: "Extract in under eight minutes.",
    check: (stats) => stats.success && stats.timeSec < 480,
  },
  {
    id: "collector",
    label: "Collector",
    detail: "Neutralize 5 hostiles and extract.",
    check: (stats) => stats.success && stats.kills >= 5,
  },
];

export function todayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function contractForDate(date: string): (typeof CONTRACTS)[number] {
  let hash = 0;
  for (let i = 0; i < date.length; i += 1) hash = (hash * 31 + date.charCodeAt(i)) >>> 0;
  return CONTRACTS[hash % CONTRACTS.length];
}

export function normalizeCallsign(raw: string): string {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e]/g, "")
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .trim()
    .slice(0, 16);
  return cleaned.length >= 2 ? cleaned : "NOVA";
}

function storedCallsign(): string {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return "NOVA";
    const parsed = JSON.parse(raw) as { nickname?: unknown };
    return typeof parsed.nickname === "string" ? normalizeCallsign(parsed.nickname) : "NOVA";
  } catch {
    return "NOVA";
  }
}

export function defaultMeta(): MetaState {
  return {
    callsign: storedCallsign(),
    xp: 0,
    credits: 0,
    missions: 0,
    extracts: 0,
    kills: 0,
    headshots: 0,
    deaths: 0,
    bestTimeSec: null,
    contract: null,
  };
}

function safeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function loadMeta(): MetaState {
  const base = defaultMeta();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return ensureTodayContract(base);
    const parsed = JSON.parse(raw) as Partial<MetaState>;
    const meta: MetaState = {
      callsign: typeof parsed.callsign === "string" ? normalizeCallsign(parsed.callsign) : base.callsign,
      xp: Math.max(0, safeNumber(parsed.xp, 0)),
      credits: Math.max(0, safeNumber(parsed.credits, 0)),
      missions: Math.max(0, safeNumber(parsed.missions, 0)),
      extracts: Math.max(0, safeNumber(parsed.extracts, 0)),
      kills: Math.max(0, safeNumber(parsed.kills, 0)),
      headshots: Math.max(0, safeNumber(parsed.headshots, 0)),
      deaths: Math.max(0, safeNumber(parsed.deaths, 0)),
      bestTimeSec:
        typeof parsed.bestTimeSec === "number" && Number.isFinite(parsed.bestTimeSec)
          ? parsed.bestTimeSec
          : null,
      contract: parsed.contract ?? null,
    };
    return ensureTodayContract(meta);
  } catch {
    return ensureTodayContract(base);
  }
}

export function ensureTodayContract(meta: MetaState): MetaState {
  const date = todayKey();
  if (meta.contract?.date === date) return meta;
  return {
    ...meta,
    contract: { date, id: contractForDate(date).id, complete: false },
  };
}

export function saveMeta(meta: MetaState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(meta));
  } catch {
    // Storage can be unavailable in private mode; the session still works.
  }
}

export function activeContract(meta: MetaState): { contract: ContractState; label: string; detail: string } {
  const state = meta.contract ?? { date: todayKey(), id: contractForDate(todayKey()).id, complete: false };
  const def = CONTRACTS.find((entry) => entry.id === state.id) ?? CONTRACTS[0];
  return { contract: state, label: def.label, detail: def.detail };
}

export interface AppliedResult {
  meta: MetaState;
  rewards: RewardReport;
}

export function applyMissionResult(meta: MetaState, stats: MissionStats): AppliedResult {
  const beforeRank = rankForXp(meta.xp).index;
  const contractInfo = activeContract(meta);
  const contractDef = CONTRACTS.find((entry) => entry.id === contractInfo.contract.id) ?? CONTRACTS[0];

  const timeBonus = stats.success ? Math.max(0, 480 - stats.timeSec) * 0.45 : 0;
  const xpGain = Math.round(
    (stats.success ? 220 : 45) +
      stats.kills * 35 +
      stats.headshots * 25 +
      stats.revives * 40 +
      timeBonus,
  );
  const baseCredits = Math.round((stats.success ? 120 : 15) + stats.kills * 12 + stats.revives * 10);

  const contractComplete = !contractInfo.contract.complete && contractDef.check(stats);
  const creditGain = baseCredits + (contractComplete ? 75 : 0);

  const next: MetaState = {
    ...meta,
    xp: meta.xp + xpGain,
    credits: meta.credits + creditGain,
    missions: meta.missions + 1,
    extracts: meta.extracts + (stats.success ? 1 : 0),
    kills: meta.kills + stats.kills,
    headshots: meta.headshots + stats.headshots,
    deaths: meta.deaths + (stats.success ? 0 : 1),
    bestTimeSec:
      stats.success && (meta.bestTimeSec === null || stats.timeSec < meta.bestTimeSec)
        ? Math.round(stats.timeSec)
        : meta.bestTimeSec,
    contract: contractComplete ? { ...contractInfo.contract, complete: true } : contractInfo.contract,
  };

  const afterRank = rankForXp(next.xp);
  saveMeta(next);

  return {
    meta: next,
    rewards: {
      xp: xpGain,
      credits: creditGain,
      rankUp: afterRank.index > beforeRank,
      contractComplete,
      contractLabel: contractDef.label,
      rankName: afterRank.name,
      rankProgress: afterRank.progress,
      nextRankXp: afterRank.nextXp,
    },
  };
}

export function rankLabel(xp: number): string {
  return rankForXp(xp).name;
}

export function rankTierCount(): number {
  return RANKS.length;
}
