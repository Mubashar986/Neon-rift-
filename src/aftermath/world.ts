import * as THREE from "three";
import type { InsertionSpec } from "./types";

export interface Box2 {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface World {
  scene: THREE.Scene;
  boxes: Box2[];
  raycastMeshes: THREE.Object3D[];
  insertionPoints: InsertionSpec[];
  terminalPosition: THREE.Vector3;
  extractionPosition: THREE.Vector3;
  extractionRadius: number;
  terminalRadius: number;
  enemySpawns: THREE.Vector3[];
  allySpawns: THREE.Vector3[];
  coverPoints: THREE.Vector3[];
  update(dt: number, playerPosition: THREE.Vector3): void;
  consumeLightning(): boolean;
  hasLineOfSight(from: THREE.Vector3, to: THREE.Vector3): boolean;
  dispose(): void;
}

export const INSERTIONS: InsertionSpec[] = [
  {
    id: "north",
    name: "NORTH GATE",
    subtitle: "Service road // low cover",
    x: 0,
    z: -54,
    angle: Math.PI,
  },
  {
    id: "west",
    name: "WEST DOCKS",
    subtitle: "Container yard // exposed approach",
    x: -54,
    z: 4,
    angle: -Math.PI / 2,
  },
  {
    id: "east",
    name: "EAST MARKET",
    subtitle: "Alley access // closest to vault",
    x: 54,
    z: -6,
    angle: Math.PI / 2,
  },
];

const WORLD_LIMIT = 58;

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function makeCanvas(width: number, height: number): CanvasRenderingContext2D {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  return ctx;
}

function makeFacadeTexture(variant: number): THREE.CanvasTexture {
  const width = 256;
  const height = 512;
  const ctx = makeCanvas(width, height);
  const palettes = [
    ["#060a12", "#0a1220", "#13233a"],
    ["#08070d", "#12101c", "#241b33"],
    ["#050b10", "#0a151a", "#102a2c"],
  ];
  const palette = palettes[variant % palettes.length];
  ctx.fillStyle = palette[0];
  ctx.fillRect(0, 0, width, height);

  const cols = 6;
  const rows = 12;
  const cellW = width / cols;
  const cellH = height / rows;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const lit = Math.random() < 0.33;
      const x = col * cellW + 8;
      const y = row * cellH + 8;
      const w = cellW - 16;
      const h = cellH - 18;
      ctx.fillStyle = lit
        ? Math.random() < 0.28
          ? "#ffb56b"
          : Math.random() < 0.5
            ? "#6fe9ff"
            : "#b98cff"
        : palette[2];
      if (lit) {
        ctx.shadowColor = ctx.fillStyle;
        ctx.shadowBlur = 12;
      }
      ctx.fillRect(x, y, w, h);
      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(0,0,0,0.32)";
      ctx.fillRect(x, y + h * 0.55, w, h * 0.45);
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);
    }
  }

  ctx.fillStyle = "rgba(120,200,255,0.06)";
  for (let i = 0; i < 90; i += 1) {
    ctx.fillRect(Math.random() * width, Math.random() * height, 1, 1);
  }

  const texture = new THREE.CanvasTexture(ctx.canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

function makeAsphaltTexture(): THREE.CanvasTexture {
  const ctx = makeCanvas(512, 512);
  ctx.fillStyle = "#07090d";
  ctx.fillRect(0, 0, 512, 512);
  const image = ctx.getImageData(0, 0, 512, 512);
  for (let i = 0; i < image.data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 18;
    image.data[i] = Math.max(0, image.data[i] + noise);
    image.data[i + 1] = Math.max(0, image.data[i + 1] + noise);
    image.data[i + 2] = Math.max(0, image.data[i + 2] + noise);
  }
  ctx.putImageData(image, 0, 0);
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  for (let i = 0; i < 7; i += 1) {
    ctx.beginPath();
    let x = Math.random() * 512;
    let y = Math.random() * 512;
    ctx.moveTo(x, y);
    for (let step = 0; step < 5; step += 1) {
      x += rand(-40, 40);
      y += rand(-40, 40);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(ctx.canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(22, 22);
  return texture;
}

function makeSignTexture(text: string, color: string): THREE.CanvasTexture {
  const ctx = makeCanvas(512, 128);
  ctx.clearRect(0, 0, 512, 128);
  ctx.font = '900 64px "Orbitron", "Arial Black", sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = color;
  ctx.shadowBlur = 28;
  ctx.fillStyle = color;
  ctx.fillText(text, 256, 68);
  ctx.shadowBlur = 12;
  ctx.fillStyle = "#f4feff";
  ctx.fillText(text, 256, 68);
  const texture = new THREE.CanvasTexture(ctx.canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function addBox2(boxes: Box2[], x: number, z: number, w: number, d: number): void {
  boxes.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });
}

export function createWorld(scene: THREE.Scene): World {
  const boxes: Box2[] = [];
  const raycastMeshes: THREE.Object3D[] = [];
  const enemySpawns: THREE.Vector3[] = [];
  const allySpawns: THREE.Vector3[] = [];
  const coverPoints: THREE.Vector3[] = [];
  const disposables: Array<{ dispose: () => void }> = [];

  scene.background = new THREE.Color("#03050a");
  scene.fog = new THREE.FogExp2(0x04060c, 0.019);

  const hemi = new THREE.HemisphereLight(0x6f95ff, 0x040509, 0.5);
  scene.add(hemi);

  const moon = new THREE.DirectionalLight(0xa8c8ff, 1.35);
  moon.position.set(28, 48, 18);
  moon.castShadow = true;
  moon.shadow.mapSize.set(2048, 2048);
  moon.shadow.camera.left = -55;
  moon.shadow.camera.right = 55;
  moon.shadow.camera.top = 55;
  moon.shadow.camera.bottom = -55;
  moon.shadow.camera.near = 1;
  moon.shadow.camera.far = 130;
  moon.shadow.bias = -0.0004;
  scene.add(moon);

  const lightning = new THREE.DirectionalLight(0x9fc7ff, 0);
  lightning.position.set(-20, 40, -30);
  scene.add(lightning);

  const asphalt = makeAsphaltTexture();
  disposables.push(asphalt);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(180, 180),
    new THREE.MeshStandardMaterial({
      map: asphalt,
      color: 0x8a93a6,
      roughness: 0.93,
      metalness: 0.18,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  raycastMeshes.push(ground);

  const concrete = new THREE.MeshStandardMaterial({
    color: 0x181d27,
    roughness: 0.82,
    metalness: 0.12,
  });
  const darkMetal = new THREE.MeshStandardMaterial({
    color: 0x0b0f16,
    roughness: 0.42,
    metalness: 0.75,
  });
  const rust = new THREE.MeshStandardMaterial({
    color: 0x2a2020,
    roughness: 0.9,
    metalness: 0.25,
  });
  const hazard = new THREE.MeshStandardMaterial({
    color: 0x3a2a08,
    emissive: 0xffa62b,
    emissiveIntensity: 0.25,
    roughness: 0.7,
  });

  function addBuilding(
    x: number,
    z: number,
    w: number,
    d: number,
    h: number,
    variant: number,
    label?: string,
    signColor = "#33f6ff",
  ): void {
    const texture = makeFacadeTexture(variant);
    texture.repeat.set(Math.max(1, Math.round(w / 9)), Math.max(1, Math.round(h / 9)));
    disposables.push(texture);
    const material = new THREE.MeshStandardMaterial({
      map: texture,
      emissiveMap: texture,
      emissive: 0xffffff,
      emissiveIntensity: 0.62,
      color: 0x2b3448,
      roughness: 0.75,
      metalness: 0.28,
    });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, h / 2, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    raycastMeshes.push(mesh);
    addBox2(boxes, x, z, w, d);

    const roof = new THREE.Mesh(new THREE.BoxGeometry(w + 0.6, 0.5, d + 0.6), darkMetal);
    roof.position.set(x, h + 0.2, z);
    roof.castShadow = true;
    scene.add(roof);
    raycastMeshes.push(roof);

    for (let i = 0; i < 2; i += 1) {
      const unit = new THREE.Mesh(new THREE.BoxGeometry(rand(1.4, 2.6), rand(0.8, 1.4), rand(1.2, 2.2)), darkMetal);
      unit.position.set(x + rand(-w / 3, w / 3), h + 0.9, z + rand(-d / 3, d / 3));
      unit.castShadow = true;
      scene.add(unit);
    }

    if (label) {
      const sign = new THREE.Mesh(
        new THREE.PlaneGeometry(9, 2.25),
        new THREE.MeshBasicMaterial({
          map: makeSignTexture(label, signColor),
          transparent: true,
          depthWrite: false,
          toneMapped: false,
          side: THREE.DoubleSide,
        }),
      );
      sign.position.set(x, Math.min(h - 2.5, 5.2), z + d / 2 + 0.04);
      scene.add(sign);
      const glow = new THREE.PointLight(new THREE.Color(signColor), 8, 12, 2);
      glow.position.set(x, sign.position.y, z + d / 2 + 1.2);
      scene.add(glow);
    }
  }

  // Four city blocks with alleys between them.
  addBuilding(23, -25, 18, 19, 22, 0, "NIGHT MARKET", "#ff3bd4");
  addBuilding(45, -20, 13, 24, 30, 1, "VOID", "#b06bff");
  addBuilding(25, -46, 18, 11, 13, 2);
  addBuilding(-20, -14, 14, 14, 20, 1, "RIFT", "#33f6ff");
  addBuilding(-50, -16, 9, 22, 17, 2, "SECTOR 7", "#ffb03b");
  addBuilding(-27, -49, 12, 8, 10, 0);
  addBuilding(22, 22, 16, 15, 18, 2, "24H", "#7dff6b");
  addBuilding(48, 20, 10, 18, 27, 0);
  addBuilding(27, 47, 15, 9, 11, 1, "NOODLES", "#ffb03b");
  addBuilding(-25, 25, 19, 17, 15, 0, "BLACKOUT", "#ff3bd4");
  addBuilding(-47, 22, 11, 20, 24, 1);
  addBuilding(-27, 47, 14, 9, 9, 2);

  // Warehouse / data vault. Walls are separate so the doorway is real.
  const vaultX = -33;
  const vaultZ = -31;
  const vaultW = 19;
  const vaultD = 15;
  function vaultWall(w: number, d: number, x: number, z: number): void {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 5.4, d), concrete);
    wall.position.set(x, 2.7, z);
    wall.castShadow = true;
    wall.receiveShadow = true;
    scene.add(wall);
    raycastMeshes.push(wall);
    addBox2(boxes, x, z, w, d);
  }
  vaultWall(vaultW, 0.7, vaultX, vaultZ - vaultD / 2);
  vaultWall(vaultW / 2 - 3, 0.7, vaultX - (vaultW / 4 + 1.5), vaultZ + vaultD / 2);
  vaultWall(vaultW / 2 - 3, 0.7, vaultX + (vaultW / 4 + 1.5), vaultZ + vaultD / 2);
  vaultWall(0.7, vaultD, vaultX - vaultW / 2, vaultZ);
  vaultWall(0.7, vaultD, vaultX + vaultW / 2, vaultZ);
  const vaultRoof = new THREE.Mesh(new THREE.BoxGeometry(vaultW + 0.4, 0.5, vaultD + 0.4), darkMetal);
  vaultRoof.position.set(vaultX, 5.6, vaultZ);
  vaultRoof.castShadow = true;
  scene.add(vaultRoof);

  const terminalPosition = new THREE.Vector3(vaultX, 0, vaultZ - 3.4);
  const terminalGroup = new THREE.Group();
  const pedestal = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.1, 1.4), darkMetal);
  pedestal.position.y = 0.55;
  pedestal.castShadow = true;
  terminalGroup.add(pedestal);
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(1.3, 0.72),
    new THREE.MeshBasicMaterial({ color: 0x54ffe1, toneMapped: false }),
  );
  screen.position.set(0, 1.3, -0.66);
  screen.rotation.x = -0.28;
  terminalGroup.add(screen);
  const screenLight = new THREE.PointLight(0x54ffe1, 18, 8, 2);
  screenLight.position.set(0, 1.8, 0);
  terminalGroup.add(screenLight);
  const terminalRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.9, 0.04, 8, 40),
    new THREE.MeshBasicMaterial({ color: 0x33f6ff, transparent: true, opacity: 0.5, toneMapped: false }),
  );
  terminalRing.rotation.x = Math.PI / 2;
  terminalRing.position.y = 1.15;
  terminalGroup.add(terminalRing);
  terminalGroup.position.set(terminalPosition.x, 0, terminalPosition.z);
  scene.add(terminalGroup);

  const vaultLight = new THREE.PointLight(0x66aaff, 25, 18, 2);
  vaultLight.position.set(vaultX, 4.3, vaultZ);
  scene.add(vaultLight);

  // Crates and low cover.
  const cratePositions: Array<[number, number, number]> = [
    [-10, -12, 2.2],
    [8, -18, 2.6],
    [16, -6, 2.2],
    [-16, 6, 2.4],
    [6, 10, 2.2],
    [-8, 18, 2.8],
    [22, 8, 2.3],
    [-22, 14, 2.5],
    [34, -4, 2.4],
    [-38, 8, 2.2],
    [12, 34, 2.6],
    [-12, 38, 2.3],
    [36, 34, 2.8],
    [-40, -40, 2.4],
    [32, -36, 2.5],
    [0, -22, 2.2],
    [0, 22, 2.2],
  ];
  for (const [x, z, size] of cratePositions) {
    const crate = new THREE.Mesh(new THREE.BoxGeometry(size, rand(1.1, 1.7), size), Math.random() < 0.24 ? rust : concrete);
    crate.position.set(x, 0.75, z);
    crate.rotation.y = rand(0, Math.PI);
    crate.castShadow = true;
    crate.receiveShadow = true;
    scene.add(crate);
    raycastMeshes.push(crate);
    addBox2(boxes, x, z, size, size);
    coverPoints.push(new THREE.Vector3(x, 0, z + size * 0.72));
    coverPoints.push(new THREE.Vector3(x, 0, z - size * 0.72));
  }

  // Interior cover and detail.
  const vaultCrate = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.4, 2.2), hazard);
  vaultCrate.position.set(vaultX + 5.2, 0.7, vaultZ + 1.8);
  vaultCrate.castShadow = true;
  scene.add(vaultCrate);
  raycastMeshes.push(vaultCrate);
  addBox2(boxes, vaultX + 5.2, vaultZ + 1.8, 2.2, 2.2);

  // Extraction pad.
  const extractionPosition = new THREE.Vector3(45, 0, 42);
  const extractionGroup = new THREE.Group();
  extractionGroup.position.copy(extractionPosition);
  const pad = new THREE.Mesh(
    new THREE.CylinderGeometry(5.2, 5.2, 0.12, 48),
    new THREE.MeshStandardMaterial({
      color: 0x08150e,
      emissive: 0x1dff89,
      emissiveIntensity: 0.2,
      roughness: 0.5,
      metalness: 0.5,
    }),
  );
  pad.position.y = 0.06;
  pad.receiveShadow = true;
  extractionGroup.add(pad);
  const padRing = new THREE.Mesh(
    new THREE.TorusGeometry(5.0, 0.08, 8, 64),
    new THREE.MeshBasicMaterial({ color: 0x51ff9d, transparent: true, opacity: 0.75, toneMapped: false }),
  );
  padRing.rotation.x = Math.PI / 2;
  padRing.position.y = 0.14;
  extractionGroup.add(padRing);
  for (let i = 0; i < 4; i += 1) {
    const light = new THREE.PointLight(0x51ff9d, 10, 8, 2);
    light.position.set(Math.cos((i / 4) * Math.PI * 2) * 4.4, 1.1, Math.sin((i / 4) * Math.PI * 2) * 4.4);
    extractionGroup.add(light);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.1, 6), darkMetal);
    post.position.copy(light.position);
    post.position.y = 0.55;
    extractionGroup.add(post);
  }
  const extractionSmoke = new THREE.Points(
    new THREE.BufferGeometry(),
    new THREE.PointsMaterial({
      color: 0x6bffb2,
      size: 0.3,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  const smokeCount = 44;
  const smokePositions = new Float32Array(smokeCount * 3);
  const smokeSeeds = new Float32Array(smokeCount);
  for (let i = 0; i < smokeCount; i += 1) {
    smokeSeeds[i] = Math.random();
    const angle = smokeSeeds[i] * Math.PI * 2;
    const radius = 2.6 + smokeSeeds[i] * 1.1;
    smokePositions[i * 3] = Math.cos(angle) * radius;
    smokePositions[i * 3 + 1] = smokeSeeds[i] * 5;
    smokePositions[i * 3 + 2] = Math.sin(angle) * radius;
  }
  extractionSmoke.geometry.setAttribute("position", new THREE.BufferAttribute(smokePositions, 3));
  extractionGroup.add(extractionSmoke);
  scene.add(extractionGroup);

  // Street lamps.
  const lampPositions: Array<[number, number, number]> = [
    [-8, -42, 0x33f6ff],
    [10, -34, 0xffb03b],
    [-36, -8, 0xb06bff],
    [36, 10, 0x33f6ff],
    [-10, 34, 0xff3bd4],
    [18, 42, 0xffb03b],
    [-44, 36, 0x33f6ff],
    [44, -42, 0xb06bff],
  ];
  for (const [x, z, color] of lampPositions) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 7, 7), darkMetal);
    pole.position.set(x, 3.5, z);
    pole.castShadow = true;
    scene.add(pole);
    const head = new THREE.Mesh(
      new THREE.BoxGeometry(1.4, 0.16, 0.45),
      new THREE.MeshBasicMaterial({ color, toneMapped: false }),
    );
    head.position.set(x, 7, z);
    scene.add(head);
    const light = new THREE.PointLight(color, 26, 21, 2);
    light.position.set(x, 6.6, z);
    scene.add(light);
  }

  // Raised road markings.
  const marking = new THREE.MeshBasicMaterial({
    color: 0x8a7a3a,
    transparent: true,
    opacity: 0.45,
  });
  for (let z = -54; z <= 54; z += 8) {
    const dash = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 3.4), marking);
    dash.rotation.x = -Math.PI / 2;
    dash.position.set(0, 0.025, z);
    scene.add(dash);
  }
  for (let x = -54; x <= 54; x += 8) {
    const dash = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 0.22), marking);
    dash.rotation.x = -Math.PI / 2;
    dash.position.set(x, 0.025, 0);
    scene.add(dash);
  }

  // Crosswalk stripes at the central intersection.
  for (let i = -5; i <= 5; i += 1) {
    const stripe = new THREE.Mesh(
      new THREE.PlaneGeometry(0.6, 3.2),
      new THREE.MeshBasicMaterial({ color: 0xb9c6d8, transparent: true, opacity: 0.22 }),
    );
    stripe.rotation.x = -Math.PI / 2;
    stripe.position.set(i * 1.1, 0.03, 7.4);
    scene.add(stripe);
  }

  // Puddles catch the neon and the environment map.
  const puddleMaterial = new THREE.MeshStandardMaterial({
    color: 0x06101c,
    roughness: 0.06,
    metalness: 0.92,
    transparent: true,
    opacity: 0.55,
  });
  for (let i = 0; i < 16; i += 1) {
    const puddle = new THREE.Mesh(new THREE.CircleGeometry(rand(0.9, 3.2), 22), puddleMaterial);
    puddle.rotation.x = -Math.PI / 2;
    puddle.position.set(rand(-52, 52), 0.02, rand(-52, 52));
    scene.add(puddle);
  }

  // Distant skyline silhouettes.
  const skylineMaterial = new THREE.MeshStandardMaterial({
    color: 0x070b13,
    emissive: 0x0a1c2e,
    emissiveIntensity: 0.5,
    roughness: 0.9,
  });
  for (let i = 0; i < 30; i += 1) {
    const angle = (i / 30) * Math.PI * 2 + rand(-0.04, 0.04);
    const radius = rand(78, 108);
    const height = rand(18, 62);
    const tower = new THREE.Mesh(new THREE.BoxGeometry(rand(6, 15), height, rand(6, 15)), skylineMaterial);
    tower.position.set(Math.cos(angle) * radius, height / 2 - 2, Math.sin(angle) * radius);
    scene.add(tower);
  }

  // Enemy spawns around the vault and the extraction route.
  const spawnPoints: Array<[number, number]> = [
    [vaultX + 1, vaultZ + 2],
    [vaultX - 7, vaultZ + 1],
    [vaultX + 7, vaultZ - 2],
    [-10, -20],
    [-38, -2],
    [33, -14],
    [18, 10],
    [33, 30],
  ];
  for (const [x, z] of spawnPoints) enemySpawns.push(new THREE.Vector3(x, 0, z));

  const insertionPoints = INSERTIONS;
  const north = insertionPoints[0];
  const west = insertionPoints[1];
  const east = insertionPoints[2];
  allySpawns.push(new THREE.Vector3(north.x + 2.2, 0, north.z + 2.4));
  allySpawns.push(new THREE.Vector3(west.x + 2.4, 0, west.z + 2.2));
  allySpawns.push(new THREE.Vector3(east.x - 2.4, 0, east.z + 2.2));

  // Rain.
  const rainCount = 1_600;
  const rainGeometry = new THREE.BufferGeometry();
  const rainPositions = new Float32Array(rainCount * 6);
  const dropsX = new Float32Array(rainCount);
  const dropsY = new Float32Array(rainCount);
  const dropsZ = new Float32Array(rainCount);
  const dropSpeed = new Float32Array(rainCount);
  for (let i = 0; i < rainCount; i += 1) {
    dropsX[i] = rand(-34, 34);
    dropsY[i] = rand(0, 26);
    dropsZ[i] = rand(-34, 34);
    dropSpeed[i] = rand(16, 28);
    rainPositions[i * 6] = dropsX[i];
    rainPositions[i * 6 + 1] = dropsY[i];
    rainPositions[i * 6 + 2] = dropsZ[i];
    rainPositions[i * 6 + 3] = dropsX[i] + 0.07;
    rainPositions[i * 6 + 4] = dropsY[i] - 0.65;
    rainPositions[i * 6 + 5] = dropsZ[i] + 0.04;
  }
  rainGeometry.setAttribute("position", new THREE.BufferAttribute(rainPositions, 3));
  const rain = new THREE.LineSegments(
    rainGeometry,
    new THREE.LineBasicMaterial({
      color: 0xbfe8ff,
      transparent: true,
      opacity: 0.24,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  rain.frustumCulled = false;
  scene.add(rain);

  let lightningTimer = rand(7, 14);
  let flash = 0;
  let pending = false;
  let elapsed = 0;

  const raycaster = new THREE.Raycaster();

  return {
    scene,
    boxes,
    raycastMeshes,
    insertionPoints,
    terminalPosition,
    extractionPosition,
    extractionRadius: 5.2,
    terminalRadius: 2.6,
    enemySpawns,
    allySpawns,
    coverPoints,
    update(dt: number, playerPosition: THREE.Vector3): void {
      elapsed += dt;
      const positions = rainGeometry.getAttribute("position") as THREE.BufferAttribute;
      const array = positions.array as Float32Array;
      for (let i = 0; i < rainCount; i += 1) {
        dropsY[i] -= dropSpeed[i] * dt;
        dropsX[i] += dt * 1.8;
        if (dropsY[i] < 0.1) {
          dropsY[i] = rand(18, 30);
          dropsX[i] = playerPosition.x + rand(-30, 30);
          dropsZ[i] = playerPosition.z + rand(-30, 30);
        }
        if (Math.abs(dropsX[i] - playerPosition.x) > 36) dropsX[i] = playerPosition.x + rand(-30, 30);
        if (Math.abs(dropsZ[i] - playerPosition.z) > 36) dropsZ[i] = playerPosition.z + rand(-30, 30);
        array[i * 6] = dropsX[i];
        array[i * 6 + 1] = dropsY[i];
        array[i * 6 + 2] = dropsZ[i];
        array[i * 6 + 3] = dropsX[i] + 0.07;
        array[i * 6 + 4] = dropsY[i] - 0.65;
        array[i * 6 + 5] = dropsZ[i] + 0.04;
      }
      positions.needsUpdate = true;

      terminalRing.rotation.z += dt * 0.8;
      (terminalRing.material as THREE.MeshBasicMaterial).opacity = 0.35 + Math.sin(elapsed * 2.4) * 0.15;
      (screen.material as THREE.MeshBasicMaterial).color.setHSL(0.47, 1, 0.55 + Math.sin(elapsed * 3.2) * 0.08);
      screenLight.intensity = 15 + Math.sin(elapsed * 3.2) * 4;

      padRing.rotation.z += dt * 0.4;
      const smokePositionsArray = extractionSmoke.geometry.getAttribute("position") as THREE.BufferAttribute;
      const smokeArray = smokePositionsArray.array as Float32Array;
      for (let i = 0; i < smokeCount; i += 1) {
        const seed = smokeSeeds[i];
        const angle = seed * Math.PI * 2 + elapsed * 0.18;
        const radius = 2.6 + seed * 1.1;
        smokeArray[i * 3 + 1] = ((elapsed * 0.55 + seed * 6) % 3.2) + 0.2;
        smokeArray[i * 3] = Math.cos(angle) * radius;
        smokeArray[i * 3 + 2] = Math.sin(angle) * radius;
      }
      smokePositionsArray.needsUpdate = true;

      lightningTimer -= dt;
      if (lightningTimer <= 0) {
        lightningTimer = rand(9, 20);
        flash = 0.11;
        pending = true;
      }
      if (flash > 0) {
        flash = Math.max(0, flash - dt);
        lightning.intensity = flash > 0 ? 2.5 + Math.random() * 3 : 0;
      } else {
        lightning.intensity = 0;
      }
    },
    consumeLightning(): boolean {
      if (!pending) return false;
      pending = false;
      return true;
    },
    hasLineOfSight(from: THREE.Vector3, to: THREE.Vector3): boolean {
      const direction = new THREE.Vector3().subVectors(to, from);
      const distance = direction.length();
      if (distance < 0.01) return true;
      direction.normalize();
      raycaster.set(from, direction);
      raycaster.far = distance;
      const hits = raycaster.intersectObjects(raycastMeshes, false);
      return hits.length === 0 || hits[0].distance >= distance - 0.5;
    },
    dispose(): void {
      scene.remove(rain);
      rainGeometry.dispose();
      (rain.material as THREE.Material).dispose();
      for (const item of disposables) item.dispose();
    },
  };
}

/** Push a circle out of every solid 2D box. Called after movement each frame. */
export function resolveWorldCollision(position: THREE.Vector3, radius: number, boxes: Box2[]): void {
  for (let pass = 0; pass < 2; pass += 1) {
    for (const box of boxes) {
      const minX = box.minX - radius;
      const maxX = box.maxX + radius;
      const minZ = box.minZ - radius;
      const maxZ = box.maxZ + radius;
      if (position.x <= minX || position.x >= maxX || position.z <= minZ || position.z >= maxZ) continue;
      const left = position.x - minX;
      const right = maxX - position.x;
      const top = position.z - minZ;
      const bottom = maxZ - position.z;
      const minimum = Math.min(left, right, top, bottom);
      if (minimum === left) position.x = minX;
      else if (minimum === right) position.x = maxX;
      else if (minimum === top) position.z = minZ;
      else position.z = maxZ;
    }
  }
  position.x = Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, position.x));
  position.z = Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, position.z));
}

export function clampToWorld(position: THREE.Vector3): void {
  position.x = Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, position.x));
  position.z = Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, position.z));
}
