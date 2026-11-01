import "./styles/base.css";
import "./styles/menu.css";
import "./styles/lobby.css";
import "./styles/hud.css";
import "./styles/results.css";
import { NeonRiftApp } from "./App";

async function boot(): Promise<void> {
  try {
    await document.fonts.ready;
  } catch {
    // Font loading is best-effort; system fallbacks are defined in CSS.
  }
  new NeonRiftApp();
}

void boot();
