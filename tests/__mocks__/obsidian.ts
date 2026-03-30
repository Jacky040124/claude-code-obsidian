// Mock for the obsidian module used in tests
export class Plugin {
  app: any = {};
  manifest: any = {};
  async loadData() { return {}; }
  async saveData(_data: any) {}
  addRibbonIcon(_icon: string, _title: string, _callback: () => void) { return document.createElement("div"); }
  addSettingTab(_tab: any) {}
  registerView(_type: string, _viewCreator: any) {}
  addCommand(_command: any) {}
}

export class PluginSettingTab {
  app: any;
  plugin: any;
  containerEl: any = document.createElement("div");
  constructor(app: any, plugin: any) {
    this.app = app;
    this.plugin = plugin;
  }
  display() {}
  hide() {}
}

export class Setting {
  settingEl: any = document.createElement("div");
  constructor(_containerEl: any) {}
  setName(_name: string) { return this; }
  setDesc(_desc: string) { return this; }
  addText(_cb: any) { return this; }
  addToggle(_cb: any) { return this; }
  addDropdown(_cb: any) { return this; }
}

export class ItemView {
  app: any;
  containerEl: any = document.createElement("div");
  contentEl: any = document.createElement("div");
  constructor(leaf: any) {
    this.app = leaf?.app;
  }
  getViewType() { return ""; }
  getDisplayText() { return ""; }
  getIcon() { return ""; }
}

export class WorkspaceLeaf {
  app: any;
  view: any;
}

export class Notice {
  constructor(_message: string, _timeout?: number) {}
}

export class Modal {
  app: any;
  contentEl: any = document.createElement("div");
  constructor(app: any) { this.app = app; }
  open() {}
  close() {}
}

export const Platform = {
  isDesktop: true,
  isMobile: false,
  isDesktopApp: true,
};

export class TFile {
  path: string = "";
  name: string = "";
  basename: string = "";
  extension: string = "";
  vault: any;
}
