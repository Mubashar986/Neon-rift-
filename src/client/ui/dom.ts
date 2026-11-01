import { PLAYER_COLORS } from "@shared/game-rules";

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`UI contract broken: missing #${id}`);
  return element as T;
}

export function requireElement<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const element = root.querySelector(selector);
  if (!element) throw new Error(`UI contract broken: missing ${selector}`);
  return element as T;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function setText(id: string, text: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}

export function setHidden(id: string, hidden: boolean): void {
  const element = document.getElementById(id);
  if (element) element.hidden = hidden;
}

export function playerColor(index: number): string {
  return PLAYER_COLORS[((index % PLAYER_COLORS.length) + PLAYER_COLORS.length) % PLAYER_COLORS.length];
}

export function initials(name: string): string {
  const cleaned = name.trim();
  if (!cleaned) return "?";
  const characters = [...cleaned];
  return characters[0].toUpperCase();
}

export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall back to the legacy path below.
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}

export function isValidNickname(name: string): boolean {
  const trimmed = name.trim();
  const length = [...trimmed].length;
  return length >= 2 && length <= 16 && /[\p{L}\p{N}]/u.test(trimmed);
}

export function invitationUrl(roomCode: string): string {
  return `${window.location.origin}/play?room=${encodeURIComponent(roomCode)}`;
}

export function inviteCodeFromLocation(): string | null {
  try {
    const url = new URL(window.location.href);
    const raw = url.searchParams.get("room") ?? url.searchParams.get("code");
    if (!raw) return null;
    const cleaned = raw.trim().toUpperCase();
    return /^[A-HJ-NP-Z2-9]{6}$/.test(cleaned) ? cleaned : null;
  } catch {
    return null;
  }
}

export function clearChildren(element: Element): void {
  while (element.firstChild) element.removeChild(element.firstChild);
}

export function playButtonFeedback(element: HTMLElement): void {
  element.classList.add("is-busy");
  setTimeout(() => element.classList.remove("is-busy"), 450);
}
