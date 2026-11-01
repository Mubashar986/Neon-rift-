import Phaser from "phaser";
import { ARENA, OBSTACLES } from "@shared/game-rules";

export const TEX = {
  spark: "nr-spark",
  glow: "nr-glow",
  bolt: "nr-bolt",
  ring: "nr-ring",
  crystal: "nr-crystal",
  core: "nr-core",
  arena: "nr-arena",
  star: "nr-star",
} as const;

function makeCanvas(
  scene: Phaser.Scene,
  key: string,
  width: number,
  height: number,
  paint: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
): void {
  if (scene.textures.exists(key)) return;
  const texture = scene.textures.createCanvas(key, width, height);
  if (!texture) return;
  const ctx = texture.getContext();
  paint(ctx, width, height);
  texture.refresh();
}

/** Procedurally draws every gameplay texture — no binary art assets needed. */
export function createCoreTextures(scene: Phaser.Scene): void {
  makeCanvas(scene, TEX.spark, 20, 20, (ctx, w) => {
    const gradient = ctx.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.35, "rgba(255,255,255,0.95)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, w);
  });

  makeCanvas(scene, TEX.star, 8, 8, (ctx, w) => {
    const gradient = ctx.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.4, "rgba(190,245,255,0.7)");
    gradient.addColorStop(1, "rgba(120,200,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, w);
  });

  makeCanvas(scene, TEX.glow, 256, 256, (ctx, w) => {
    const gradient = ctx.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    gradient.addColorStop(0, "rgba(255,255,255,0.95)");
    gradient.addColorStop(0.22, "rgba(255,255,255,0.55)");
    gradient.addColorStop(0.5, "rgba(255,255,255,0.16)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, w);
  });

  makeCanvas(scene, TEX.bolt, 72, 24, (ctx, w, h) => {
    const gradient = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.28, "rgba(255,255,255,0.92)");
    gradient.addColorStop(0.62, "rgba(255,255,255,0.26)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(1, 0.34);
    ctx.translate(-w / 2, -h / 2);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.beginPath();
    ctx.ellipse(w / 2, h / 2, w * 0.2, h * 0.16, 0, 0, Math.PI * 2);
    ctx.fill();
  });

  makeCanvas(scene, TEX.ring, 160, 160, (ctx, w) => {
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth = 5;
    ctx.shadowColor = "rgba(255,255,255,0.9)";
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.arc(w / 2, w / 2, w / 2 - 12, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.42;
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.arc(w / 2, w / 2, w / 2 - 9, 0, Math.PI * 2);
    ctx.stroke();
  });

  makeCanvas(scene, TEX.crystal, 48, 64, (ctx, w, h) => {
    const cx = w / 2;
    const top = 6;
    const bottom = h - 6;
    const gradient = ctx.createLinearGradient(0, top, 0, bottom);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.42, "rgba(220,255,255,0.95)");
    gradient.addColorStop(1, "rgba(150,220,255,0.8)");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(cx, top);
    ctx.lineTo(cx + 17, h * 0.4);
    ctx.lineTo(cx + 10, bottom - 3);
    ctx.lineTo(cx, bottom);
    ctx.lineTo(cx - 10, bottom - 3);
    ctx.lineTo(cx - 17, h * 0.4);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, top + 2);
    ctx.lineTo(cx - 5, h * 0.48);
    ctx.lineTo(cx, bottom - 4);
    ctx.moveTo(cx, top + 2);
    ctx.lineTo(cx + 6, h * 0.46);
    ctx.lineTo(cx + 3, bottom - 8);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.beginPath();
    ctx.moveTo(cx - 5, h * 0.22);
    ctx.lineTo(cx, h * 0.36);
    ctx.lineTo(cx + 3, h * 0.2);
    ctx.closePath();
    ctx.fill();
  });

  makeCanvas(scene, TEX.core, 128, 128, (ctx, w, h) => {
    const cx = w / 2;
    const cy = h / 2;
    const gradient = ctx.createRadialGradient(cx, cy, 2, cx, cy, w / 2);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.3, "rgba(255,244,200,1)");
    gradient.addColorStop(0.62, "rgba(255,176,59,0.9)");
    gradient.addColorStop(1, "rgba(255,59,212,0)");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(cx, 4);
    ctx.lineTo(w - 12, cy);
    ctx.lineTo(cx, h - 4);
    ctx.lineTo(12, cy);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, 10);
    ctx.lineTo(w - 20, cy);
    ctx.lineTo(cx, h - 10);
    ctx.lineTo(20, cy);
    ctx.closePath();
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.45)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(cx, 24);
    ctx.lineTo(cx + 32, cy);
    ctx.lineTo(cx, h - 24);
    ctx.lineTo(cx - 32, cy);
    ctx.closePath();
    ctx.stroke();
  });
}

function mulberry32(seed: number): () => number {
  let value = seed;
  return () => {
    value |= 0;
    value = (value + 0x6d2b79f5) | 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A single 2400×1600 painted floor: gradients, grid, plating seams, lane
 * markings and billboard type. Rendered once into a texture and reused.
 */
export function createArenaBackground(scene: Phaser.Scene): void {
  makeCanvas(scene, TEX.arena, ARENA.width, ARENA.height, (ctx, w, h) => {
    const rng = mulberry32(0x51f7);

    ctx.fillStyle = "#04070f";
    ctx.fillRect(0, 0, w, h);

    const base = ctx.createLinearGradient(0, 0, w, h);
    base.addColorStop(0, "rgba(8,16,32,0.9)");
    base.addColorStop(0.48, "rgba(4,8,18,1)");
    base.addColorStop(1, "rgba(9,10,26,0.9)");
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, h);

    // Broad coloured atmosphere pools.
    const pools: Array<[number, number, number, string]> = [
      [w / 2, h / 2, 760, "rgba(90,28,255,0.16)"],
      [w * 0.18, h * 0.2, 520, "rgba(51,246,255,0.07)"],
      [w * 0.84, h * 0.8, 560, "rgba(255,59,212,0.06)"],
      [w * 0.82, h * 0.18, 420, "rgba(176,107,255,0.06)"],
    ];
    for (const [x, y, radius, color] of pools) {
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, color);
      gradient.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }

    // Fine grid.
    ctx.lineWidth = 1;
    for (let x = 0; x <= w; x += 80) {
      const major = x % 400 === 0;
      ctx.strokeStyle = major ? "rgba(80,170,230,0.10)" : "rgba(80,170,230,0.045)";
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 0; y <= h; y += 80) {
      const major = y % 400 === 0;
      ctx.strokeStyle = major ? "rgba(80,170,230,0.10)" : "rgba(80,170,230,0.045)";
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // Plate seams and micro-detail.
    for (let i = 0; i < 90; i++) {
      const x = Math.floor(rng() * (w / 80)) * 80;
      const y = Math.floor(rng() * (h / 80)) * 80;
      const width = 80 * (1 + Math.floor(rng() * 3));
      const height = 80 * (1 + Math.floor(rng() * 2));
      ctx.strokeStyle = `rgba(100,180,255,${0.02 + rng() * 0.035})`;
      ctx.strokeRect(x + 6, y + 6, width - 12, height - 12);
      if (rng() > 0.72) {
        ctx.fillStyle = "rgba(51,246,255,0.05)";
        ctx.fillRect(x + 18, y + 18, 8, 2);
      }
    }

    // Diagonal accent cuts.
    const cuts: Array<[number, number, number, number, string]> = [
      [0, h * 0.72, w * 0.2, 0, "rgba(51,246,255,0.05)"],
      [w, h * 0.28, w * 0.26, 0, "rgba(176,107,255,0.06)"],
      [0, h * 0.3, w * 0.16, 0, "rgba(255,59,212,0.04)"],
    ];
    for (const [x1, y1, x2, y2, color] of cuts) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 + x2, y1 + y2);
      ctx.stroke();
    }

    // Hex ripple around the core.
    ctx.strokeStyle = "rgba(176,107,255,0.10)";
    ctx.lineWidth = 1;
    for (let ring = 1; ring <= 4; ring++) {
      const radius = 180 + ring * 105;
      const sides = 6;
      ctx.beginPath();
      for (let i = 0; i <= sides; i++) {
        const angle = (i / sides) * Math.PI * 2 + Math.PI / 6;
        const x = w / 2 + Math.cos(angle) * radius;
        const y = h / 2 + Math.sin(angle) * radius * 0.86;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      if (ring % 2 === 0) {
        ctx.setLineDash([3, 12]);
      } else {
        ctx.setLineDash([]);
      }
    }
    ctx.setLineDash([]);

    // Lane markings.
    const lane = (x: number, y: number, length: number, vertical: boolean) => {
      for (let offset = 0; offset < length; offset += 54) {
        ctx.fillStyle = "rgba(120,220,255,0.055)";
        if (vertical) ctx.fillRect(x - 2, y + offset, 4, 26);
        else ctx.fillRect(x + offset, y - 2, 26, 4);
      }
    };
    lane(w / 2, 96, h - 192, true);
    lane(96, h / 2, w - 192, false);

    // Border hazard bands.
    ctx.fillStyle = "rgba(51,246,255,0.05)";
    ctx.fillRect(48, 48, w - 96, 3);
    ctx.fillRect(48, h - 51, w - 96, 3);
    ctx.fillRect(48, 48, 3, h - 96);
    ctx.fillRect(w - 51, 48, 3, h - 96);
    for (let x = 80; x < w - 80; x += 42) {
      ctx.strokeStyle = "rgba(255,176,59,0.12)";
      ctx.beginPath();
      ctx.moveTo(x, 54);
      ctx.lineTo(x + 10, 64);
      ctx.moveTo(x, h - 54);
      ctx.lineTo(x + 10, h - 64);
      ctx.stroke();
    }

    // Corner portal glyphs.
    const portal = (cx: number, cy: number, scale: number) => {
      ctx.strokeStyle = "rgba(51,246,255,0.12)";
      ctx.lineWidth = 2;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.arc(cx, cy, (38 + i * 18) * scale, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(cx - 26 * scale, cy);
      ctx.lineTo(cx + 26 * scale, cy);
      ctx.moveTo(cx, cy - 26 * scale);
      ctx.lineTo(cx, cy + 26 * scale);
      ctx.stroke();
    };
    portal(120, 120, 0.8);
    portal(w - 120, 120, 0.8);
    portal(120, h - 120, 0.8);
    portal(w - 120, h - 120, 0.8);

    // Floor typography.
    ctx.save();
    ctx.globalAlpha = 0.05;
    ctx.fillStyle = "#9ffaff";
    ctx.font = '900 170px "Orbitron", "Arial Black", sans-serif';
    ctx.textAlign = "left";
    ctx.fillText("RIFT", 170, 430);
    ctx.fillText("01", w - 420, h - 180);
    ctx.globalAlpha = 0.03;
    ctx.font = '700 54px "Orbitron", sans-serif';
    ctx.fillText("SECTOR // THE RIFT", 174, 500);
    ctx.fillText("KEEP CLEAR OF CORE", w - 780, h - 260);
    ctx.restore();

    // Vignette.
    const vignette = ctx.createRadialGradient(w / 2, h / 2, h * 0.24, w / 2, h / 2, h * 0.92);
    vignette.addColorStop(0, "rgba(0,0,0,0)");
    vignette.addColorStop(0.7, "rgba(1,3,9,0.28)");
    vignette.addColorStop(1, "rgba(1,3,9,0.72)");
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);

    // Faint collision shadow behind every obstacle so cover reads clearly.
    for (const obstacle of OBSTACLES) {
      if (obstacle.id === "core") continue;
      ctx.fillStyle = "rgba(0,0,0,0.28)";
      if (obstacle.kind === "rect") {
        ctx.fillRect(obstacle.x - 8, obstacle.y - 8, obstacle.w + 16, obstacle.h + 16);
      }
    }
  });
}
