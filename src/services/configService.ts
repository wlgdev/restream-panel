import type { Application, ApplicationData, NginxConfig, OperationResult } from "../core/types";
import { parseNginxConfig, generateNginxConfig, getApplicationByName, applicationNameExists } from "../core";
import { isProtectedApplication, isValidApplicationName, getTargetServerById, TARGET_SERVERS } from "../core/constants";

export class ConfigService {
  private configPath: string;
  private currentConfig: NginxConfig | null = null;

  constructor(configPath: string) {
    this.configPath = configPath;
  }

  async loadConfig(): Promise<OperationResult<NginxConfig>> {
    try {
      const content = await Bun.file(this.configPath).text();
      const result = parseNginxConfig(content);

      if (!result.success || !result.config) {
        return {
          success: false,
          error: result.error || "Failed to parse config",
        };
      }

      this.currentConfig = result.config;
      return {
        success: true,
        data: result.config,
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to read config file: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  async saveConfig(): Promise<OperationResult> {
    if (!this.currentConfig) {
      return {
        success: false,
        error: "No config loaded",
      };
    }

    try {
      await this.createBackup();

      const result = generateNginxConfig(this.currentConfig);

      if (!result.success || !result.content) {
        return {
          success: false,
          error: result.error || "Failed to generate config",
        };
      }

      await Bun.write(this.configPath, result.content);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: `Failed to save config: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  private async createBackup(): Promise<void> {
    const backupPath = `${this.configPath}.backup`;
    const content = await Bun.file(this.configPath).text();
    await Bun.write(backupPath, content);
  }

  async getApplications(): Promise<OperationResult<Application[]>> {
    if (!this.currentConfig) {
      const loadResult = await this.loadConfig();
      if (!loadResult.success) {
        return { success: false, error: loadResult.error };
      }
    }

    return {
      success: true,
      data: this.currentConfig!.applications,
    };
  }

  async getConfiguredStreamTargets(): Promise<OperationResult<NginxConfig["streamTargets"]>> {
    if (!this.currentConfig) {
      const loadResult = await this.loadConfig();
      if (!loadResult.success) {
        return { success: false, error: loadResult.error };
      }
    }

    return {
      success: true,
      data: this.currentConfig!.streamTargets,
    };
  }

  async getApplication(name: string): Promise<OperationResult<Application>> {
    if (!this.currentConfig) {
      const loadResult = await this.loadConfig();
      if (!loadResult.success) {
        return { success: false, error: loadResult.error };
      }
    }

    const app = getApplicationByName(this.currentConfig!, name);
    if (!app) {
      return {
        success: false,
        error: `Application '${name}' not found`,
      };
    }

    return { success: true, data: app };
  }

  async addApplication(data: ApplicationData): Promise<OperationResult<Application>> {
    if (!this.currentConfig) {
      const loadResult = await this.loadConfig();
      if (!loadResult.success) {
        return { success: false, error: loadResult.error };
      }
    }

    if (!isValidApplicationName(data.name)) {
      return {
        success: false,
        error:
          "Invalid application name. Must contain only letters, numbers, and underscores, and be 1-64 characters.",
      };
    }

    if (applicationNameExists(this.currentConfig!, data.name)) {
      return {
        success: false,
        error: `Application '${data.name}' already exists`,
      };
    }

    if (data.pushTargets.length === 0) {
      return {
        success: false,
        error: "At least one push target is required",
      };
    }

    const pushTargets = this.buildPushTargets(data.pushTargets);
    if (!pushTargets) {
      return {
        success: false,
        error: "Invalid push target configuration",
      };
    }

    const newApp: Application = {
      name: data.name,
      isProtected: false,
      pushTargets,
    };

    this.currentConfig!.applications.push(newApp);

    const saveResult = await this.saveConfig();
    if (!saveResult.success) {
      this.currentConfig!.applications.pop();
      return { success: false, error: saveResult.error };
    }

    return { success: true, data: newApp };
  }

  async updateApplication(name: string, data: ApplicationData): Promise<OperationResult<Application>> {
    if (!this.currentConfig) {
      const loadResult = await this.loadConfig();
      if (!loadResult.success) {
        return { success: false, error: loadResult.error };
      }
    }

    const appIndex = this.currentConfig!.applications.findIndex((a) => a.name === name);
    if (appIndex === -1) {
      return {
        success: false,
        error: `Application '${name}' not found`,
      };
    }

    const app = this.currentConfig!.applications[appIndex];

    if (app?.isProtected) {
      return {
        success: false,
        error: `Application '${name}' is protected and cannot be modified`,
      };
    }

    if (data.name !== name) {
      if (!isValidApplicationName(data.name)) {
        return {
          success: false,
          error: "Invalid application name",
        };
      }

      if (applicationNameExists(this.currentConfig!, data.name)) {
        return {
          success: false,
          error: `Application '${data.name}' already exists`,
        };
      }
    }

    if (data.pushTargets.length === 0) {
      return {
        success: false,
        error: "At least one push target is required",
      };
    }

    const pushTargets = this.buildPushTargets(data.pushTargets);
    if (!pushTargets) {
      return {
        success: false,
        error: "Invalid push target configuration",
      };
    }

    const oldApp: Application = {
      ...app!,
      pushTargets: app!.pushTargets.map((t) => ({ ...t, server: { ...t.server } })),
    };

    this.currentConfig!.applications[appIndex] = {
      name: data.name,
      isProtected: false,
      pushTargets,
    };

    const saveResult = await this.saveConfig();
    if (!saveResult.success) {
      this.currentConfig!.applications[appIndex] = oldApp;
      return { success: false, error: saveResult.error };
    }

    return { success: true, data: this.currentConfig!.applications[appIndex] };
  }

  async deleteApplication(name: string): Promise<OperationResult> {
    if (!this.currentConfig) {
      const loadResult = await this.loadConfig();
      if (!loadResult.success) {
        return { success: false, error: loadResult.error };
      }
    }

    const appIndex = this.currentConfig!.applications.findIndex((a) => a.name === name);
    if (appIndex === -1) {
      return {
        success: false,
        error: `Application '${name}' not found`,
      };
    }

    const app = this.currentConfig!.applications[appIndex];

    if (app?.isProtected) {
      return {
        success: false,
        error: `Application '${name}' is protected and cannot be deleted`,
      };
    }

    const deletedApp = this.currentConfig!.applications.splice(appIndex, 1)[0];

    const saveResult = await this.saveConfig();
    if (!saveResult.success) {
      this.currentConfig!.applications.splice(appIndex, 0, deletedApp!);
      return saveResult;
    }

    return { success: true };
  }

  getTargetServers() {
    return TARGET_SERVERS;
  }

  private buildPushTargets(targets: { serverId: string; streamKey: string }[]): Application["pushTargets"] | null {
    const pushTargets: Application["pushTargets"] = [];

    for (const target of targets) {
      const server = getTargetServerById(target.serverId);
      if (!server) {
        return null;
      }

      pushTargets.push({
        server,
        streamKey: target.streamKey,
      });
    }

    return pushTargets;
  }

  async reloadConfig(): Promise<OperationResult<NginxConfig>> {
    return this.loadConfig();
  }
}
