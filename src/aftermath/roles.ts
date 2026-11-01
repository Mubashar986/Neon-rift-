import type { RoleSpec } from "./types";

export const ROLES: RoleSpec[] = [
  {
    id: "assault",
    name: "ASSAULT",
    codename: "VK-7",
    tagline: "Balanced breacher",
    description:
      "Reliable automatic rifle, medium armor and the stamina to push the objective. The default choice when the plan goes wrong.",
    weapon: "VK-7 RIFLE",
    magazine: 30,
    reserve: 150,
    rpm: 620,
    damage: 24,
    armor: 60,
    speed: 4.7,
    stamina: 100,
    adsZoom: 55,
    color: "#33f6ff",
  },
  {
    id: "recon",
    name: "RECON",
    codename: "M-90",
    tagline: "Range and information",
    description:
      "High-damage marksman rifle with a tight optic. Faster on foot, lighter armor. Rewards patience, punishes panic.",
    weapon: "M-90 DMR",
    magazine: 10,
    reserve: 70,
    rpm: 190,
    damage: 58,
    armor: 40,
    speed: 5.1,
    stamina: 110,
    adsZoom: 38,
    color: "#b06bff",
  },
  {
    id: "support",
    name: "SUPPORT",
    codename: "AR-6",
    tagline: "Sustain and suppression",
    description:
      "Belt-fed light machine gun, heavy plates and slower feet. Holds a corridor while the squad moves, and keeps allies in the fight.",
    weapon: "AR-6 LMG",
    magazine: 60,
    reserve: 240,
    rpm: 540,
    damage: 19,
    armor: 90,
    speed: 4.15,
    stamina: 85,
    adsZoom: 62,
    color: "#ffb03b",
  },
];

export function roleById(id: string): RoleSpec {
  return ROLES.find((role) => role.id === id) ?? ROLES[0];
}
