import * as THREE from "three";

export type ActorState = "alive" | "downed" | "dead";

export interface ActorRig {
  group: THREE.Group;
  muzzle: THREE.Object3D;
  state: ActorState;
  setHealth(ratio: number): void;
  setDowned(): void;
  setDead(): void;
  setAlive(): void;
  setTagDistance(distance: number): void;
  animate(dt: number, speed: number, aiming: boolean): void;
  flashMuzzle(): void;
  dispose(): void;
}

interface RigParts {
  body: THREE.Group;
  legs: [THREE.Group, THREE.Group];
  arms: [THREE.Group, THREE.Group];
  head: THREE.Mesh;
  muzzleFlash: THREE.Mesh;
  tag: THREE.Sprite;
  tagTexture: THREE.CanvasTexture;
  tagCanvas: HTMLCanvasElement;
  tagContext: CanvasRenderingContext2D;
  callsign: string;
  accent: string;
  dispose: () => void;
}

function createTag(callsign: string, accent: string, friendly: boolean): {
  sprite: THREE.Sprite;
  texture: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
} {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas unavailable");
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.45, 0.36, 1);
  sprite.position.y = 2.12;
  const draw = (ratio: number): void => {
    context.clearRect(0, 0, 256, 64);
    context.fillStyle = "rgba(4, 8, 16, 0.72)";
    context.fillRect(10, 4, 236, 56);
    context.strokeStyle = friendly ? "rgba(80, 245, 255, 0.55)" : "rgba(255, 90, 110, 0.5)";
    context.lineWidth = 2;
    context.strokeRect(10, 4, 236, 56);
    context.font = '700 22px "Rajdhani", "Arial Narrow", sans-serif';
    context.textAlign = "left";
    context.textBaseline = "middle";
    context.fillStyle = "#eafcff";
    context.fillText(callsign.toUpperCase().slice(0, 12), 22, 24);
    context.fillStyle = "rgba(255,255,255,0.16)";
    context.fillRect(22, 40, 212, 7);
    context.fillStyle = accent;
    context.fillRect(22, 40, 212 * Math.max(0, Math.min(1, ratio)), 7);
    texture.needsUpdate = true;
  };
  draw(1);
  return { sprite, texture, canvas, context };
}

export function createSoldier(callsign: string, accentHex: string, friendly: boolean): ActorRig {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);

  const accent = new THREE.Color(accentHex);
  const accentMaterial = new THREE.MeshStandardMaterial({
    color: 0x0d121b,
    emissive: accent,
    emissiveIntensity: 1.4,
    roughness: 0.4,
    metalness: 0.6,
  });
  const cloth = new THREE.MeshStandardMaterial({
    color: friendly ? 0x1a2833 : 0x241a20,
    roughness: 0.92,
    metalness: 0.05,
  });
  const armor = new THREE.MeshStandardMaterial({
    color: friendly ? 0x243544 : 0x34222a,
    roughness: 0.55,
    metalness: 0.35,
  });
  const skin = new THREE.MeshStandardMaterial({
    color: 0x1b1d22,
    roughness: 0.9,
    metalness: 0.05,
  });
  const gunMetal = new THREE.MeshStandardMaterial({ color: 0x0a0d12, roughness: 0.35, metalness: 0.85 });

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [accentMaterial, cloth, armor, skin, gunMetal];

  function box(
    width: number,
    height: number,
    depth: number,
    material: THREE.Material,
  ): THREE.Mesh {
    const geometry = new THREE.BoxGeometry(width, height, depth);
    geometries.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  const torso = box(0.62, 0.62, 0.34, cloth);
  torso.position.y = 1.2;
  body.add(torso);

  const vest = box(0.5, 0.4, 0.38, armor);
  vest.position.set(0, 1.24, 0.01);
  body.add(vest);

  const chestLight = box(0.16, 0.06, 0.02, accentMaterial);
  chestLight.position.set(0.16, 1.36, -0.2);
  body.add(chestLight);

  const belt = box(0.58, 0.1, 0.32, armor);
  belt.position.y = 0.88;
  body.add(belt);

  const head = box(0.3, 0.3, 0.3, skin);
  head.position.y = 1.64;
  body.add(head);

  const helmet = box(0.34, 0.16, 0.34, armor);
  helmet.position.y = 1.76;
  body.add(helmet);

  const visor = box(0.26, 0.07, 0.02, accentMaterial);
  visor.position.set(0, 1.65, -0.16);
  body.add(visor);

  const legGeometry = new THREE.BoxGeometry(0.18, 0.84, 0.2);
  geometries.push(legGeometry);
  const legMesh = (): THREE.Mesh => {
    const mesh = new THREE.Mesh(legGeometry, cloth);
    mesh.position.y = -0.42;
    mesh.castShadow = true;
    return mesh;
  };
  const legLeft = new THREE.Group();
  legLeft.position.set(-0.16, 0.84, 0);
  legLeft.add(legMesh());
  const legRight = new THREE.Group();
  legRight.position.set(0.16, 0.84, 0);
  legRight.add(legMesh());
  body.add(legLeft, legRight);

  const bootGeometry = new THREE.BoxGeometry(0.22, 0.12, 0.32);
  geometries.push(bootGeometry);
  const bootLeft = new THREE.Mesh(bootGeometry, armor);
  bootLeft.position.set(0, -0.86, -0.05);
  bootLeft.castShadow = true;
  legLeft.add(bootLeft);
  const bootRight = new THREE.Mesh(bootGeometry, armor);
  bootRight.position.set(0, -0.86, -0.05);
  bootRight.castShadow = true;
  legRight.add(bootRight);

  const armGeometry = new THREE.BoxGeometry(0.15, 0.56, 0.15);
  geometries.push(armGeometry);
  const armLeft = new THREE.Group();
  armLeft.position.set(-0.38, 1.4, 0);
  const armLeftMesh = new THREE.Mesh(armGeometry, cloth);
  armLeftMesh.position.y = -0.26;
  armLeftMesh.castShadow = true;
  armLeft.add(armLeftMesh);
  const armRight = new THREE.Group();
  armRight.position.set(0.38, 1.4, 0);
  const armRightMesh = new THREE.Mesh(armGeometry, cloth);
  armRightMesh.position.y = -0.26;
  armRightMesh.castShadow = true;
  armRight.add(armRightMesh);
  body.add(armLeft, armRight);

  armLeft.rotation.x = -0.85;
  armRight.rotation.x = -1.02;
  armLeft.rotation.z = 0.12;
  armRight.rotation.z = -0.16;

  const gun = new THREE.Group();
  const receiver = box(0.1, 0.13, 0.62, gunMetal);
  receiver.position.z = -0.14;
  gun.add(receiver);
  const barrel = box(0.05, 0.05, 0.36, gunMetal);
  barrel.position.set(0, 0.02, -0.56);
  gun.add(barrel);
  const stock = box(0.08, 0.16, 0.24, armor);
  stock.position.set(0, -0.02, 0.26);
  gun.add(stock);
  const sight = box(0.04, 0.08, 0.12, accentMaterial);
  sight.position.set(0, 0.1, -0.2);
  gun.add(sight);
  gun.position.set(0.26, 1.3, -0.26);
  gun.rotation.x = 0.03;
  body.add(gun);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.02, -0.76);
  gun.add(muzzle);

  const flashMaterial = new THREE.MeshBasicMaterial({
    color: friendly ? 0xaef7ff : 0xffc48a,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const flashGeometry = new THREE.PlaneGeometry(0.42, 0.42);
  geometries.push(flashGeometry);
  materials.push(flashMaterial);
  const muzzleFlash = new THREE.Mesh(flashGeometry, flashMaterial);
  muzzleFlash.position.copy(muzzle.position);
  muzzleFlash.visible = false;
  gun.add(muzzleFlash);

  const tagInfo = createTag(callsign, accentHex, friendly);
  const tag = tagInfo.sprite;
  body.add(tag);

  let flashTimer = 0;
  let walkPhase = Math.random() * Math.PI * 2;
  let state: ActorState = "alive";
  let currentRatio = 1;

  const parts: RigParts = {
    body,
    legs: [legLeft, legRight],
    arms: [armLeft, armRight],
    head,
    muzzleFlash,
    tag,
    tagTexture: tagInfo.texture,
    tagCanvas: tagInfo.canvas,
    tagContext: tagInfo.context,
    callsign,
    accent: accentHex,
    dispose: () => {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      tagInfo.texture.dispose();
      (tag.material as THREE.SpriteMaterial).dispose();
    },
  };

  const rig: ActorRig = {
    group,
    muzzle,
    get state(): ActorState {
      return state;
    },
    setHealth(ratio: number): void {
      const clamped = Math.max(0, Math.min(1, ratio));
      if (Math.abs(clamped - currentRatio) < 0.02) {
        currentRatio = clamped;
        return;
      }
      currentRatio = clamped;
      tagInfo.context.clearRect(0, 0, 256, 64);
      tagInfo.context.fillStyle = "rgba(4, 8, 16, 0.72)";
      tagInfo.context.fillRect(10, 4, 236, 56);
      tagInfo.context.strokeStyle = friendly ? "rgba(80, 245, 255, 0.55)" : "rgba(255, 90, 110, 0.5)";
      tagInfo.context.lineWidth = 2;
      tagInfo.context.strokeRect(10, 4, 236, 56);
      tagInfo.context.font = '700 22px "Rajdhani", "Arial Narrow", sans-serif';
      tagInfo.context.textAlign = "left";
      tagInfo.context.textBaseline = "middle";
      tagInfo.context.fillStyle = "#eafcff";
      tagInfo.context.fillText(parts.callsign.toUpperCase().slice(0, 12), 22, 24);
      tagInfo.context.fillStyle = "rgba(255,255,255,0.16)";
      tagInfo.context.fillRect(22, 40, 212, 7);
      tagInfo.context.fillStyle = parts.accent;
      tagInfo.context.fillRect(22, 40, 212 * clamped, 7);
      tagInfo.texture.needsUpdate = true;
    },
    setDowned(): void {
      state = "downed";
      body.rotation.x = -Math.PI * 0.42;
      body.rotation.z = 0.18;
      body.position.y = 0.3;
      tag.position.y = 1.4;
      (tag.material as THREE.SpriteMaterial).opacity = 0.85;
    },
    setDead(): void {
      state = "dead";
      body.rotation.x = -Math.PI * 0.47;
      body.rotation.z = 0.3;
      body.position.y = 0.22;
      tag.visible = false;
      flashTimer = 0;
      muzzleFlash.visible = false;
    },
    setAlive(): void {
      state = "alive";
      body.rotation.x = 0;
      body.rotation.z = 0;
      body.position.y = 0;
      tag.visible = true;
      (tag.material as THREE.SpriteMaterial).opacity = 1;
    },
    setTagDistance(distance: number): void {
      const material = tag.material as THREE.SpriteMaterial;
      if (state === "dead") {
        tag.visible = false;
        return;
      }
      const close = 2.1;
      const fade = 3.6;
      if (distance <= close) {
        material.opacity = 0;
        tag.visible = false;
      } else {
        tag.visible = true;
        material.opacity = distance >= fade ? 1 : (distance - close) / (fade - close);
      }
    },
    animate(dt: number, speed: number, aiming: boolean): void {
      if (state !== "alive") {
        walkPhase += dt * 0.6;
        return;
      }
      walkPhase += dt * (3.2 + speed * 1.35);
      const swing = Math.sin(walkPhase) * Math.min(1, speed / 4.5) * 0.72;
      legLeft.rotation.x = swing;
      legRight.rotation.x = -swing;
      armLeft.rotation.x = -0.85 - swing * 0.22;
      armRight.rotation.x = -1.02 + swing * 0.08;
      const bob = Math.abs(Math.cos(walkPhase)) * Math.min(1, speed / 4.5) * 0.035;
      body.position.y = bob;
      torso.rotation.x = aiming ? -0.06 : 0;
      tag.position.y = 2.18 + bob;
      if (flashTimer > 0) {
        flashTimer -= dt;
        if (flashTimer <= 0) muzzleFlash.visible = false;
      }
    },
    flashMuzzle(): void {
      flashTimer = 0.055;
      muzzleFlash.visible = true;
      muzzleFlash.rotation.z = Math.random() * Math.PI;
      muzzleFlash.scale.setScalar(0.8 + Math.random() * 0.7);
    },
    dispose: parts.dispose,
  };

  return rig;
}
