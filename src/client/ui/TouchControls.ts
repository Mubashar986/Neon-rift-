import { byId } from "./dom";

interface StickState {
  active: boolean;
  pointerId: number | null;
  centerX: number;
  centerY: number;
  radius: number;
  x: number;
  y: number;
}

/**
 * Multi-touch joystick + action buttons. Movement is analog; the right stick
 * sets aim and the FIRE/DASH buttons are independent so you can move, aim and
 * shoot simultaneously on a phone.
 */
export class TouchControls {
  private controls = byId("mobile-controls");
  private moveStick = byId("move-stick");
  private moveThumb = byId("move-thumb");
  private aimStick = byId("aim-stick");
  private aimThumb = byId("aim-thumb");
  private fireButton = byId<HTMLButtonElement>("btn-touch-fire");
  private dashButton = byId<HTMLButtonElement>("btn-touch-dash");

  private move: StickState = emptyStick();
  private aim: StickState = emptyStick();
  private moveVector = { x: 0, y: 0 };
  private aimAngle = 0;
  private hasAim = false;
  private firing = false;
  private firePointer: number | null = null;
  private dashQueued = false;

  constructor() {
    this.bindStick(this.moveStick, this.moveThumb, this.move, (x, y, magnitude) => {
      this.moveVector.x = x;
      this.moveVector.y = y;
      void magnitude;
    }, () => {
      this.moveVector.x = 0;
      this.moveVector.y = 0;
    });

    this.bindStick(this.aimStick, this.aimThumb, this.aim, (x, y, magnitude) => {
      if (magnitude > 0.22) {
        this.aimAngle = Math.atan2(y, x);
        this.hasAim = true;
      }
    }, () => {
      // Keep the last aim when the right thumb is released.
    });

    this.bindFire();
    this.bindDash();
  }

  setActive(active: boolean): void {
    this.controls.hidden = !active;
    if (!active) this.reset();
  }

  getState(): { moveX: number; moveY: number; aim: number; hasAim: boolean } {
    return {
      moveX: this.moveVector.x,
      moveY: this.moveVector.y,
      aim: this.aimAngle,
      hasAim: this.hasAim,
    };
  }

  get isFiring(): boolean {
    return this.firing;
  }

  consumeDash(): boolean {
    if (!this.dashQueued) return false;
    this.dashQueued = false;
    return true;
  }

  reset(): void {
    this.moveVector = { x: 0, y: 0 };
    this.firing = false;
    this.dashQueued = false;
    this.firePointer = null;
    this.hasAim = false;
    this.aimAngle = 0;
    this.resetStick(this.move, this.moveThumb);
    this.resetStick(this.aim, this.aimThumb);
    this.fireButton.classList.remove("is-pressed");
    this.dashButton.classList.remove("is-pressed");
  }

  private bindStick(
    element: HTMLElement,
    thumb: HTMLElement,
    state: StickState,
    onVector: (x: number, y: number, magnitude: number) => void,
    onRelease: () => void,
  ): void {
    const update = (clientX: number, clientY: number) => {
      const dx = clientX - state.centerX;
      const dy = clientY - state.centerY;
      const distance = Math.hypot(dx, dy);
      const clamped = Math.min(distance, state.radius);
      const nx = distance > 0.001 ? (dx / distance) * (clamped / state.radius) : 0;
      const ny = distance > 0.001 ? (dy / distance) * (clamped / state.radius) : 0;
      state.x = dx;
      state.y = dy;
      const offsetX = distance > 0.001 ? (dx / distance) * clamped : 0;
      const offsetY = distance > 0.001 ? (dy / distance) * clamped : 0;
      thumb.style.transform = `translate(calc(-50% + ${offsetX}px), calc(-50% + ${offsetY}px))`;
      onVector(nx, ny, Math.min(1, distance / state.radius));
    };

    const start = (event: PointerEvent) => {
      if (state.active) return;
      const rect = element.getBoundingClientRect();
      state.active = true;
      state.pointerId = event.pointerId;
      state.centerX = rect.left + rect.width / 2;
      state.centerY = rect.top + rect.height / 2;
      state.radius = Math.max(24, rect.width / 2 - 8);
      element.setPointerCapture?.(event.pointerId);
      update(event.clientX, event.clientY);
      event.preventDefault();
    };

    const move = (event: PointerEvent) => {
      if (!state.active || event.pointerId !== state.pointerId) return;
      update(event.clientX, event.clientY);
      event.preventDefault();
    };

    const end = (event: PointerEvent) => {
      if (!state.active || event.pointerId !== state.pointerId) return;
      this.resetStick(state, thumb);
      onRelease();
      event.preventDefault();
    };

    element.addEventListener("pointerdown", start);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", end);
    element.addEventListener("pointercancel", end);
    element.addEventListener("lostpointercapture", end);
    element.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  private resetStick(state: StickState, thumb: HTMLElement): void {
    state.active = false;
    state.pointerId = null;
    state.x = 0;
    state.y = 0;
    thumb.style.transform = "translate(-50%, -50%)";
  }

  private bindFire(): void {
    const press = (event: PointerEvent) => {
      this.firing = true;
      this.firePointer = event.pointerId;
      this.fireButton.classList.add("is-pressed");
      event.preventDefault();
    };
    const release = (event: PointerEvent) => {
      if (this.firePointer !== null && event.pointerId !== this.firePointer) return;
      this.firing = false;
      this.firePointer = null;
      this.fireButton.classList.remove("is-pressed");
    };
    this.fireButton.addEventListener("pointerdown", press);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    this.fireButton.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  private bindDash(): void {
    const press = (event: PointerEvent) => {
      this.dashQueued = true;
      this.dashButton.classList.add("is-pressed");
      setTimeout(() => this.dashButton.classList.remove("is-pressed"), 160);
      event.preventDefault();
    };
    this.dashButton.addEventListener("pointerdown", press);
    this.dashButton.addEventListener("contextmenu", (event) => event.preventDefault());
  }
}

function emptyStick(): StickState {
  return { active: false, pointerId: null, centerX: 0, centerY: 0, radius: 1, x: 0, y: 0 };
}
