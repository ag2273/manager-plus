import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS, type DesktopApi } from "../shared/api";

const api: DesktopApi = {
  createBusiness: (settings) => ipcRenderer.invoke(CHANNELS.createBusiness, settings),
  openBusiness: (path) => ipcRenderer.invoke(CHANNELS.openBusiness, path),
  recentFiles: () => ipcRenderer.invoke(CHANNELS.recentFiles),
  call: (method, args) => ipcRenderer.invoke(CHANNELS.call, method, args),
  preferences: () => ipcRenderer.invoke(CHANNELS.preferences),
  setPreferences: (preferences) => ipcRenderer.invoke(CHANNELS.setPreferences, preferences),
};

contextBridge.exposeInMainWorld("api", api);
