import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS, type DesktopApi } from "../shared/api";

const api: DesktopApi = {
  createBusiness: (settings) => ipcRenderer.invoke(CHANNELS.createBusiness, settings),
  openBusiness: (path) => ipcRenderer.invoke(CHANNELS.openBusiness, path),
  recentFiles: () => ipcRenderer.invoke(CHANNELS.recentFiles),
};

contextBridge.exposeInMainWorld("api", api);
