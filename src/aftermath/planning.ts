import { rankForXp } from "./ballistics";
import { activeContract } from "./meta";
import { ROLES } from "./roles";
import { INSERTIONS } from "./world";
import { ALLY_CALLSIGNS, type InsertionSpec, type MetaState, type MissionConfig, type RoleSpec } from "./types";

function mustGet<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

function formatTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const INTEL: Record<string, string> = {
  north:
    "The north service road is the quietest approach. Long sightlines to the vault door, but almost no hard cover on the way in.",
  west:
    "The container yard gives the squad real cover and a flank. Patrols sweep it on a slow rotation — use the noise of the rain.",
  east:
    "The market alley puts you closest to the vault, and closest to everyone else. Fastest route to the core, loudest way out.",
};

export class Planning {
  private readonly screen = mustGet("aw-planning");
  private readonly roleList = mustGet("aw-role-list");
  private readonly insertionList = mustGet("aw-insertion-list");
  private readonly contractLabel = mustGet("aw-contract-label");
  private readonly contractDetail = mustGet("aw-contract-detail");
  private readonly contractState = mustGet("aw-contract-state");
  private readonly intel = mustGet("aw-intel-text");
  private readonly roster = mustGet("aw-roster");
  private readonly recordInput = mustGet<HTMLInputElement>("aw-record");
  private readonly deployButton = mustGet<HTMLButtonElement>("aw-deploy");
  private readonly deployLabel = this.deployButton.querySelector("span");
  private readonly deploySub = this.deployButton.querySelector("em");

  private selectedRole: RoleSpec = ROLES[0];
  private selectedInsertion: InsertionSpec = INSERTIONS[0];
  private readonly onDeploy: (config: MissionConfig) => void;
  private deployed = false;

  constructor(onDeploy: (config: MissionConfig) => void) {
    this.onDeploy = onDeploy;
    this.buildRoles();
    this.buildInsertions();
    this.buildRoster();
    this.deployButton.addEventListener("click", () => this.deploy());
    this.refreshMetaPlaceholder();
  }

  show(): void {
    this.deployed = false;
    this.screen.classList.remove("is-hidden");
    this.deployButton.disabled = false;
    if (this.deployLabel) this.deployLabel.textContent = "DEPLOY TO DISTRICT 07";
    if (this.deploySub) this.deploySub.textContent = "ENTER THE RIFT";
  }

  hide(): void {
    this.screen.classList.add("is-hidden");
  }

  setBusy(busy: boolean): void {
    this.deployButton.disabled = busy;
    if (this.deployLabel) this.deployLabel.textContent = busy ? "SYNCING DISTRICT 07" : "DEPLOY TO DISTRICT 07";
  }

  get config(): MissionConfig {
    return {
      role: this.selectedRole,
      insertion: this.selectedInsertion,
      record: this.recordInput.checked,
    };
  }

  refresh(meta: MetaState): void {
    const rank = rankForXp(meta.xp);
    const platformCallsign = meta.callsign || "NOVA";
    mustGet("aw-callsign").textContent = platformCallsign;
    mustGet("aw-rank").textContent = rank.name;
    mustGet("aw-credits").textContent = String(meta.credits);
    mustGet("aw-career-rank").textContent = rank.name;
    mustGet("aw-career-xp").textContent = String(meta.xp);
    mustGet("aw-career-missions").textContent = String(meta.missions);
    mustGet("aw-career-extracts").textContent = String(meta.extracts);
    mustGet("aw-career-best").textContent = formatTime(meta.bestTimeSec);
    mustGet("aw-career-fill").style.width = `${Math.round(rank.progress * 100)}%`;

    const contract = activeContract(meta);
    this.contractLabel.textContent = contract.label;
    this.contractDetail.textContent = contract.detail;
    this.contractState.textContent = contract.contract.complete ? "COMPLETE" : "ACTIVE";
    this.contractState.classList.toggle("is-done", contract.contract.complete);

    this.refreshMetaPlaceholder(false);
  }

  private refreshMetaPlaceholder(useDefaults = true): void {
    if (!useDefaults) return;
    mustGet("aw-callsign").textContent = "NOVA";
    mustGet("aw-rank").textContent = "RECRUIT";
    mustGet("aw-credits").textContent = "0";
    mustGet("aw-career-rank").textContent = "RECRUIT";
    mustGet("aw-career-xp").textContent = "0";
    mustGet("aw-career-missions").textContent = "0";
    mustGet("aw-career-extracts").textContent = "0";
    mustGet("aw-career-best").textContent = "—";
  }

  private buildRoles(): void {
    this.roleList.replaceChildren();
    for (const [index, role] of ROLES.entries()) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `aw-role${role.id === this.selectedRole.id ? " is-selected" : ""}`;
      button.dataset.role = role.id;
      button.setAttribute("aria-pressed", String(role.id === this.selectedRole.id));
      button.style.setProperty("--role-color", role.color);

      const top = document.createElement("div");
      top.className = "aw-role__top";
      const number = document.createElement("span");
      number.className = "aw-role__index";
      number.textContent = String(index + 1).padStart(2, "0");
      const tag = document.createElement("span");
      tag.className = "aw-role__tag";
      tag.textContent = role.name;
      const radio = document.createElement("i");
      radio.className = "aw-role__radio";
      top.append(number, tag, radio);

      const heading = document.createElement("h2");
      heading.textContent = role.codename;
      const weaponTag = document.createElement("em");
      weaponTag.textContent = role.weapon.split(" ").slice(-1)[0];
      heading.append(weaponTag);

      const tagline = document.createElement("p");
      tagline.textContent = role.tagline;

      const stats = document.createElement("div");
      stats.className = "aw-role__stats";
      const stat = (label: string, value: number): HTMLDivElement => {
        const wrapper = document.createElement("div");
        wrapper.className = "aw-role__stat";
        const name = document.createElement("span");
        name.textContent = label;
        const bar = document.createElement("div");
        bar.className = "aw-role__bar";
        const fill = document.createElement("i");
        fill.style.width = `${Math.max(8, Math.min(100, Math.round(value * 100)))}%`;
        bar.append(fill);
        wrapper.append(name, bar);
        return wrapper;
      };
      stats.append(
        stat("DAMAGE", role.damage / 60),
        stat("ARMOR", role.armor / 90),
        stat("MOBILITY", role.speed / 5.2),
      );

      const description = document.createElement("div");
      description.className = "aw-role__desc";
      description.textContent = role.description;

      button.append(top, heading, tagline, stats, description);
      button.addEventListener("click", () => this.selectRole(role));
      this.roleList.append(button);
    }
  }

  private buildInsertions(): void {
    this.insertionList.replaceChildren();
    for (const [index, insertion] of INSERTIONS.entries()) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `aw-insertion${insertion.id === this.selectedInsertion.id ? " is-selected" : ""}`;
      button.dataset.insertion = insertion.id;
      const left = Math.max(9, Math.min(88, ((insertion.x + 58) / 116) * 100));
      const top = Math.max(9, Math.min(88, ((insertion.z + 58) / 116) * 100));
      button.style.left = `${left}%`;
      button.style.top = `${top}%`;

      const name = document.createElement("strong");
      name.textContent = `${String(index + 1).padStart(2, "0")} // ${insertion.name}`;
      const subtitle = document.createElement("span");
      subtitle.textContent = insertion.subtitle;
      button.append(name, subtitle);
      button.addEventListener("click", () => this.selectInsertion(insertion));
      this.insertionList.append(button);
    }
    this.intel.textContent = INTEL[this.selectedInsertion.id] ?? INTEL.north;
  }

  private buildRoster(): void {
    this.roster.replaceChildren();
    for (const callsign of ALLY_CALLSIGNS) {
      const item = document.createElement("div");
      item.className = "aw-roster__unit";
      const dot = document.createElement("i");
      const name = document.createElement("span");
      name.textContent = callsign;
      const note = document.createElement("em");
      note.textContent = "AI SQUADMATE";
      item.append(dot, name, note);
      this.roster.append(item);
    }
  }

  private selectRole(role: RoleSpec): void {
    this.selectedRole = role;
    for (const child of this.roleList.children) {
      const element = child as HTMLElement;
      const selected = element.dataset.role === role.id;
      element.classList.toggle("is-selected", selected);
      element.setAttribute("aria-pressed", String(selected));
    }
    if (this.deploySub) this.deploySub.textContent = `${role.weapon} // ${role.name}`;
  }

  private selectInsertion(insertion: InsertionSpec): void {
    this.selectedInsertion = insertion;
    for (const child of this.insertionList.children) {
      const element = child as HTMLElement;
      element.classList.toggle("is-selected", element.dataset.insertion === insertion.id);
    }
    this.intel.textContent = INTEL[insertion.id] ?? INTEL.north;
  }

  private deploy(): void {
    if (this.deployed) return;
    this.deployed = true;
    this.setBusy(true);
    this.onDeploy(this.config);
  }
}
