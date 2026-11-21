import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS, type DesktopApi } from "../shared/api";

const api: DesktopApi = {
  createBusiness: (settings, manager) => ipcRenderer.invoke(CHANNELS.createBusiness, settings, manager),
  signIn: (credentials) => ipcRenderer.invoke(CHANNELS.signIn, credentials),
  signOut: () => ipcRenderer.invoke(CHANNELS.signOut),
  openBusiness: (path) => ipcRenderer.invoke(CHANNELS.openBusiness, path),
  recentFiles: () => ipcRenderer.invoke(CHANNELS.recentFiles),
  call: (method, args) => ipcRenderer.invoke(CHANNELS.call, method, args),
  preferences: () => ipcRenderer.invoke(CHANNELS.preferences),
  setPreferences: (preferences) => ipcRenderer.invoke(CHANNELS.setPreferences, preferences),
  printers: () => ipcRenderer.invoke(CHANNELS.printers),
  print: (request) => ipcRenderer.invoke(CHANNELS.print, request),
  printA4: (request) => ipcRenderer.invoke(CHANNELS.printA4, request),
  exportExcel: (table) => ipcRenderer.invoke(CHANNELS.exportExcel, table),
  openSpreadsheet: () => ipcRenderer.invoke(CHANNELS.openSpreadsheet),
  saveImportTemplate: (lang) => ipcRenderer.invoke(CHANNELS.saveImportTemplate, lang),
  discoverServers: () => ipcRenderer.invoke(CHANNELS.discoverServers),
  lastServer: () => ipcRenderer.invoke(CHANNELS.lastServer),
  connectServer: (host, port) => ipcRenderer.invoke(CHANNELS.connectServer, host, port),
  connection: () => ipcRenderer.invoke(CHANNELS.connection),
  serverStatus: () => ipcRenderer.invoke(CHANNELS.serverStatus),
  setServing: (on, port) => ipcRenderer.invoke(CHANNELS.setServing, on, port),
};

contextBridge.exposeInMainWorld("api", api);
