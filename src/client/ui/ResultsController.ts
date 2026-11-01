import type { MatchResults } from "@shared/types";
import { byId, clearChildren, el, formatDuration, initials, playerColor } from "./dom";

export interface ResultsCallbacks {
  onRematch: () => void;
  onPlayAgain: () => void;
  onReturnLobby: () => void;
}

const REASON_LABEL: Record<MatchResults["reason"], string> = {
  time: "TIMER",
  score: "SCORE LIMIT",
  aborted: "ABORTED",
};

export class ResultsController {
  private title = byId("results-title");
  private subtitle = byId("results-subtitle");
  private winnerAvatar = byId("winner-avatar");
  private winnerName = byId("winner-name");
  private winnerScore = byId("winner-score");
  private duration = byId("results-duration");
  private reason = byId("results-reason");
  private limit = byId("results-limit");
  private body = byId("results-body");
  private rematch = byId<HTMLButtonElement>("btn-rematch");
  private playAgain = byId<HTMLButtonElement>("btn-play-again");
  private returnLobby = byId<HTMLButtonElement>("btn-return-lobby");
  private hostNote = byId("results-host-note");

  constructor(callbacks: ResultsCallbacks) {
    this.rematch.addEventListener("click", () => callbacks.onRematch());
    this.playAgain.addEventListener("click", () => callbacks.onPlayAgain());
    this.returnLobby.addEventListener("click", () => callbacks.onReturnLobby());
  }

  render(results: MatchResults, selfId: string, isHost: boolean): void {
    const winners = results.rankings.filter((entry) => results.winners.includes(entry.playerId));
    const winnerNames = winners.map((entry) => entry.name);
    const shared = winners.length > 1;

    this.title.textContent = shared ? "SHARED VICTORY" : "RIFT CHAMPION";
    this.subtitle.textContent = shared
      ? `The rift refused to split ${winnerNames.join(" and ")}.`
      : results.reason === "score"
        ? "Score limit reached. The grid bows."
        : "Time expired. The grid falls silent.";

    const lead = winners[0];
    this.winnerAvatar.textContent = shared ? "×2" : lead ? initials(lead.name) : "?";
    this.winnerAvatar.style.setProperty("--avatar-color", playerColor(lead?.color ?? 0));
    this.winnerName.textContent = winnerNames.length > 0 ? winnerNames.join(" & ") : "NO CONTEST";
    const topScore = lead?.score ?? 0;
    this.winnerScore.textContent = shared ? `${topScore} POINTS EACH` : `${topScore} POINTS`;
    this.duration.textContent = formatDuration(results.durationMs);
    this.reason.textContent = REASON_LABEL[results.reason];
    this.limit.textContent = results.scoreLimit > 0 ? String(results.scoreLimit) : "OFF";

    clearChildren(this.body);
    for (const entry of results.rankings) {
      const row = el("tr", "results-row");
      if (entry.playerId === selfId) row.classList.add("is-self");
      if (entry.rank === 1) row.classList.add("is-winner");
      row.dataset.playerId = entry.playerId;

      const rankCell = el("td", "results-rank", entry.rank === 1 ? "★" : String(entry.rank));
      row.appendChild(rankCell);

      const pilotCell = el("td", "results-pilot");
      const avatar = el("span", "avatar avatar--sm", initials(entry.name));
      avatar.style.setProperty("--avatar-color", playerColor(entry.color));
      pilotCell.appendChild(avatar);
      const nameWrap = el("span", "results-pilot__copy");
      nameWrap.appendChild(el("strong", undefined, entry.name));
      if (entry.playerId === selfId) nameWrap.appendChild(el("small", undefined, "YOU"));
      pilotCell.appendChild(nameWrap);
      row.appendChild(pilotCell);

      row.appendChild(el("td", "results-score", String(entry.score)));
      row.appendChild(el("td", undefined, String(entry.kills)));
      row.appendChild(el("td", undefined, String(entry.deaths)));
      row.appendChild(el("td", undefined, String(entry.crystals)));
      this.body.appendChild(row);
    }

    this.returnLobby.disabled = !isHost;
    this.returnLobby.title = isHost ? "Return everyone to the lobby" : "Only the host can return to the lobby";
    this.hostNote.hidden = isHost;
    this.hostNote.textContent = isHost
      ? ""
      : "Only the host can return everyone to the lobby. Rematch is open to every pilot.";
  }

  setBusy(busy: boolean): void {
    this.rematch.disabled = busy;
    this.playAgain.disabled = busy;
    this.returnLobby.disabled = busy || this.returnLobby.disabled;
  }
}
