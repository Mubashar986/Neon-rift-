import { byId } from "./dom";

export type ModalName = "join" | "settings" | "help" | "pause";

const MODAL_IDS: Record<ModalName, string> = {
  join: "modal-join",
  settings: "modal-settings",
  help: "modal-help",
  pause: "modal-pause",
};

export interface ModalManagerOptions {
  onTopChange?: (top: ModalName | null, stack: ModalName[]) => void;
  onOpen?: (name: ModalName) => void;
  onClose?: (name: ModalName) => void;
}

/**
 * A small stack-based modal controller. Opening settings from the pause modal
 * keeps the pause modal underneath instead of destroying game context.
 */
export class ModalManager {
  private stack: ModalName[] = [];
  private previousFocus: HTMLElement | null = null;
  private elements = new Map<ModalName, HTMLElement>();

  constructor(private readonly options: ModalManagerOptions = {}) {
    for (const name of Object.keys(MODAL_IDS) as ModalName[]) {
      const element = byId(MODAL_IDS[name]);
      this.elements.set(name, element);
      element.hidden = true;
    }

    document.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const opener = target.closest<HTMLElement>("[data-open-modal]");
      if (opener) {
        const name = opener.dataset.openModal as ModalName | undefined;
        if (name && name in MODAL_IDS) {
          this.open(name);
          return;
        }
      }
      const closer = target.closest<HTMLElement>("[data-close-modal]");
      if (closer) {
        const name = closer.dataset.closeModal as ModalName | undefined;
        if (name) this.close(name);
      }
    });
  }

  get isOpen(): boolean {
    return this.stack.length > 0;
  }

  get top(): ModalName | null {
    return this.stack[this.stack.length - 1] ?? null;
  }

  get stackSnapshot(): ModalName[] {
    return [...this.stack];
  }

  open(name: ModalName): void {
    const existingIndex = this.stack.indexOf(name);
    if (existingIndex >= 0) {
      this.stack.splice(existingIndex, 1);
    } else {
      this.options.onOpen?.(name);
    }
    this.stack.push(name);
    this.render();
  }

  close(name: ModalName): void {
    const index = this.stack.indexOf(name);
    if (index < 0) return;
    this.stack.splice(index, 1);
    this.options.onClose?.(name);
    this.render();
  }

  closeTop(): boolean {
    const top = this.top;
    if (!top) return false;
    this.close(top);
    return true;
  }

  closeAll(): void {
    if (this.stack.length === 0) return;
    const names = [...this.stack];
    this.stack = [];
    for (const name of names) this.options.onClose?.(name);
    this.render();
  }

  private render(): void {
    const top = this.top;
    for (const [name, element] of this.elements) {
      element.hidden = name !== top;
    }
    document.body.classList.toggle("modal-open", this.stack.length > 0);

    if (top) {
      if (!this.previousFocus) {
        this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      }
      const panel = this.elements.get(top);
      const focusable = panel?.querySelector<HTMLElement>(
        "input:not([type=hidden]), button, select, [tabindex]:not([tabindex='-1'])",
      );
      window.setTimeout(() => focusable?.focus({ preventScroll: true }), 60);
    } else if (this.previousFocus) {
      this.previousFocus.focus({ preventScroll: true });
      this.previousFocus = null;
    }

    this.options.onTopChange?.(top, [...this.stack]);
  }
}
