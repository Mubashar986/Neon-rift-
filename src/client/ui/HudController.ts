import { PLAYER_STATS } from "@shared/game-rules";
import type { MatchRosterEntry, MatchStartInfo, SnapshotMsg } from "@shared/types";
import { byId, clearChildren, el, formatClock, setText } from "./dom";

const DASH_TOTAL = PLAYER_STATS.dash.cooldownMs;

/**
 * DOM HUD. It only ever renders server snapshots — health, score, timer and
 * dash charge are never computed from client-side guesses.
 */
export class HudController {
  private hud = byId("hud");
  private healthFill = byId("hud-health-fill");
  private healthText = byId("hud-health-text");
  private timer = byId("hud-timer");
  private phase = byId("hud-phase");
  private scoreLimit = byId("hud-score-limit");
  private score = byId("hud-score");
  private kills = byId("hud-kills");
  private crystals = byId("hud-crystals");
  private playerName = byId("hud-player-name");
  private leaderboard = byId("hud-leaderboard");
  private dashFill = byId("dash-fill");
  private dashStatus = byId("dash-status");
  private dashOrb = byId("dash-orb");
  private touchDash = byId<HTMLButtonElement>("btn-touch-dash");
  private ping = byId("hud-ping");
  private pingText = byId("hud-ping-text");
  private killFeed = byId("kill-feed");
  private countdownOverlay = byId("countdown-overlay");
  private countdownValue = byId("countdown-value");
  private countdownCaption = document.querySelector<HTMLElement>(".countdown-caption");
  private respawnOverlay = byId("respawn-overlay");
  private respawnTimer = byId("respawn-timer");
  private damage = byId("fx-damage");

  private roster = new Map<string, MatchRosterEntry>();
  private selfId = "";
  private boardSignature = "";
  private fightTimer: ReturnType<typeof setTimeout> | null = null;
  private damageTimer: ReturnType<typeof setTimeout> | null = null;
  private criticalTimer: ReturnType<typeof setTimeout> | null = null;
  private feedTimers = new Set<ReturnType<typeof setTimeout>>();
  private lastSnapshot: SnapshotMsg | null = null;

  reset(match: MatchStartInfo, selfId: string): void {
    this.selfId = selfId;
    this.roster = new Map(match.roster.map((entry) => [entry.id, entry]));
    this.boardSignature = "";
    this.lastSnapshot = null;
    const self = this.roster.get(selfId);
    this.playerName.textContent = self?.name ?? "PILOT";
    setText("hud-score", "0");
    setText("hud-kills", "0");
    setText("hud-crystals", "0");
    this.healthFill.style.width = "100%";
    this.healthText.textContent = String(PLAYER_STATS.maxHealth);
    this.timer.textContent = formatClock(match.durationSec * 1000);
    this.phase.textContent = "DEPLOYING";
    this.scoreLimit.textContent =
      match.scoreLimit > 0 ? `FIRST TO ${match.scoreLimit}` : "TIMED MATCH";
    this.scoreLimit.dataset.limit = String(match.scoreLimit);
    this.countdownOverlay.hidden = false;
    this.countdownValue.classList.remove("is-live");
    this.countdownValue.textContent = String(Math.max(1, Math.ceil(match.countdownMs / 1000)));
    if (this.countdownCaption) this.countdownCaption.textContent = "RIFT MATERIALIZING";
    this.respawnOverlay.hidden = true;
    this.hud.classList.remove("is-low-health", "is-dead");
    this.killFeed.replaceChildren();
    this.clearFightTimer();
    this.setPing(null, true);
  }

  update(snapshot: SnapshotMsg): void {
    this.lastSnapshot = snapshot;
    const self = snapshot.players.find((player) => player.id === this.selfId);

    if (snapshot.phase === "countdown") {
      this.phase.textContent = "DEPLOYING";
      this.countdownOverlay.hidden = false;
      this.countdownValue.classList.remove("is-live");
      this.countdownValue.textContent = String(Math.max(1, Math.ceil(snapshot.countdownMs / 1000)));
      this.respawnOverlay.hidden = true;
    } else if (snapshot.phase === "playing") {
      this.phase.textContent = "LIVE";
      if (!this.fightTimer) this.countdownOverlay.hidden = true;
      this.timer.classList.toggle("is-critical", snapshot.remainMs <= 30_000);
    }

    this.timer.textContent = formatClock(snapshot.remainMs);

    if (self) {
      const hp = Math.max(0, Math.round(self.hp));
      const ratio = Math.max(0, Math.min(1, hp / PLAYER_STATS.maxHealth));
      this.healthFill.style.width = `${(ratio * 100).toFixed(1)}%`;
      this.healthText.textContent = String(hp);
      this.hud.classList.toggle("is-low-health", self.alive && ratio > 0 && ratio <= 0.3);
      this.hud.classList.toggle("is-dead", !self.alive);
      this.score.textContent = String(self.score);
      this.kills.textContent = String(self.kills);
      this.crystals.textContent = String(self.crystals);

      const dashReady = Math.max(0, Math.min(1, 1 - self.dashCooldownMs / DASH_TOTAL));
      this.dashFill.style.setProperty("--dash", String(Math.round(dashReady * 100)));
      this.dashStatus.textContent = self.dashCooldownMs <= 0 ? "READY" : "CHARGING";
      this.dashOrb.classList.toggle("is-ready", self.dashCooldownMs <= 0);
      this.touchDash.style.setProperty("--dash-charge", String(Math.round(dashReady * 100)));
      this.touchDash.classList.toggle("is-charging", self.dashCooldownMs > 0);

      if (!self.alive) {
        this.respawnOverlay.hidden = false;
        this.respawnTimer.textContent = Math.max(0, self.respawnInMs / 1000).toFixed(1);
      } else {
        this.respawnOverlay.hidden = true;
      }
    }

    this.renderLeaderboard(snapshot);
  }

  setPing(latency: number | null, online: boolean): void {
    this.ping.classList.toggle("is-offline", !online);
    this.ping.classList.toggle("is-bad", online && latency !== null && latency > 140);
    this.pingText.textContent = !online ? "LINK LOST" : latency === null ? "-- ms" : `${Math.round(latency)} ms`;
  }

  addKillFeed(killerName: string, victimName: string): void {
    const entry = el("div", "kill-feed__entry");
    entry.appendChild(el("strong", undefined, killerName));
    entry.appendChild(el("span", "kill-icon", "⊢"));
    entry.appendChild(el("strong", undefined, victimName));
    this.pushFeed(entry);
  }

  addCrystalFeed(playerName: string, amount: number): void {
    const entry = el("div", "kill-feed__entry is-crystal");
    entry.appendChild(el("strong", undefined, playerName));
    entry.appendChild(el("span", "accent", `+${amount} CRYSTAL`));
    this.pushFeed(entry);
  }

  flashDamage(critical: boolean): void {
    this.damage.classList.add("is-hit");
    if (this.damageTimer) clearTimeout(this.damageTimer);
    this.damageTimer = setTimeout(() => this.damage.classList.remove("is-hit"), 150);
    this.damage.classList.toggle("is-critical", critical);
    if (this.criticalTimer) clearTimeout(this.criticalTimer);
    if (critical) {
      this.criticalTimer = setTimeout(() => this.damage.classList.remove("is-critical"), 2_600);
    }
  }

  showFight(): void {
    this.clearFightTimer();
    this.countdownOverlay.hidden = false;
    this.countdownValue.classList.add("is-live");
    this.countdownValue.textContent = "FIGHT";
    if (this.countdownCaption) this.countdownCaption.textContent = "RIFT OPEN";
    this.fightTimer = setTimeout(() => {
      this.fightTimer = null;
      this.countdownOverlay.hidden = true;
      this.countdownValue.classList.remove("is-live");
    }, 1_050);
  }

  finish(): void {
    this.respawnOverlay.hidden = true;
    this.countdownOverlay.hidden = true;
    this.clearFightTimer();
  }

  dispose(): void {
    this.clearFightTimer();
    if (this.damageTimer) clearTimeout(this.damageTimer);
    if (this.criticalTimer) clearTimeout(this.criticalTimer);
    for (const timer of this.feedTimers) clearTimeout(timer);
    this.feedTimers.clear();
  }

  private renderLeaderboard(snapshot: SnapshotMsg): void {
    const sorted = [...snapshot.players].sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.kills !== a.kills) return b.kills - a.kills;
      return a.deaths - b.deaths;
    });
    const signature = sorted
      .map((player) => `${player.id}:${player.score}:${player.kills}:${player.alive}`)
      .join("|");
    if (signature === this.boardSignature) return;
    this.boardSignature = signature;

    clearChildren(this.leaderboard);
    sorted.forEach((player, index) => {
      const rosterEntry = this.roster.get(player.id);
      const row = el("li", "mini-board__row");
      row.dataset.playerId = player.id;
      if (player.id === this.selfId) row.classList.add("is-self");
      if (!player.alive) row.classList.add("is-dead");
      row.appendChild(el("span", "mini-board__rank", String(index + 1)));
      row.appendChild(el("span", "mini-board__name", rosterEntry?.name ?? "PILOT"));
      row.appendChild(el("span", "mini-board__kills", `${player.kills}K`));
      row.appendChild(el("span", "mini-board__score", String(player.score)));
      this.leaderboard.appendChild(row);
    });
  }

  private pushFeed(entry: HTMLElement): void {
    this.killFeed.prepend(entry);
    while (this.killFeed.children.length > 5) {
      this.killFeed.lastElementChild?.remove();
    }
    const timer = setTimeout(() => {
      entry.classList.add("is-leaving");
      setTimeout(() => entry.remove(), 260);
      this.feedTimers.delete(timer);
    }, 4_800);
    this.feedTimers.add(timer);
  }

  private clearFightTimer(): void {
    if (this.fightTimer) clearTimeout(this.fightTimer);
    this.fightTimer = null;
  }

  get snapshot(): SnapshotMsg | null {
    return this.lastSnapshot;
  }
}
