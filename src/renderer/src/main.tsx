import "@fontsource/ibm-plex-sans-arabic/400.css";
import "@fontsource/ibm-plex-sans-arabic/500.css";
import "@fontsource/ibm-plex-sans-arabic/600.css";
import "@fontsource/ibm-plex-sans-arabic/700.css";
import "./theme.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { inTauri, tauriApi } from "./tauri";

// In the Tauri app there is no Electron preload; the same API goes over Tauri's IPC.
if (inTauri()) window.api = tauriApi;

createRoot(document.getElementById("root")!).render(<App />);
