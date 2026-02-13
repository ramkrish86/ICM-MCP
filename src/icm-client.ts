import {
  InteractiveBrowserCredential,
  TokenCredential,
} from "@azure/identity";
import { IcMConfig, IcMIncident, IcMQueryParams, TroubleshootingEntry, IncidentUpdate } from "./types.js";

export class IcMClient {
  private config: IcMConfig;
  private credential: TokenCredential;
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;

  constructor(config: IcMConfig) {
    this.config = config;

    // Interactive browser auth with Microsoft Entra ID
    this.credential = new InteractiveBrowserCredential({
      tenantId: config.tenantId || undefined,
    });
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && now < this.tokenExpiry - 60000) {
      return this.accessToken;
    }

    const token = await this.credential.getToken(this.config.apiScope);
    if (!token) {
      throw new Error("Failed to acquire access token for IcM API");
    }
    this.accessToken = token.token;
    this.tokenExpiry = token.expiresOnTimestamp;
    return this.accessToken;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.getAccessToken();
    const url = `${this.config.apiBaseUrl}${path}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    const options: RequestInit = { method, headers };
    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`IcM API error ${response.status}: ${errorText}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  async queryIncidents(params: IcMQueryParams): Promise<IcMIncident[]> {
    const queryParts: string[] = [];

    if (params.teamId) {
      queryParts.push(`OwningTeamId eq '${params.teamId}'`);
    }
    if (params.severity) {
      queryParts.push(`Severity eq ${params.severity}`);
    }
    if (params.status) {
      queryParts.push(`Status eq '${params.status}'`);
    }
    if (params.createdAfter) {
      queryParts.push(`Source/CreateDate ge ${params.createdAfter}`);
    }
    if (params.createdBefore) {
      queryParts.push(`Source/CreateDate le ${params.createdBefore}`);
    }
    if (params.filter) {
      queryParts.push(params.filter);
    }

    const top = params.top || 25;
    let path = `/api/cert/incidents?$top=${top}`;
    if (queryParts.length > 0) {
      path += `&$filter=${encodeURIComponent(queryParts.join(" and "))}`;
    }
    path += `&$orderby=${encodeURIComponent("Source/CreateDate desc")}`;

    const result = await this.request<{ value: IcMIncident[] }>("GET", path);
    return result.value || [];
  }

  async getIncident(incidentId: number): Promise<IcMIncident> {
    return this.request<IcMIncident>("GET", `/api/cert/incidents(${incidentId})`);
  }

  async createIncident(incident: IcMIncident): Promise<IcMIncident> {
    return this.request<IcMIncident>("POST", "/api/cert/incidents", incident);
  }

  async updateIncident(incidentId: number, update: IncidentUpdate): Promise<void> {
    await this.request<void>("PATCH", `/api/cert/incidents(${incidentId})`, update);
  }

  async addTroubleshootingEntry(entry: TroubleshootingEntry): Promise<void> {
    await this.request<void>(
      "POST",
      `/api/cert/incidents(${entry.IncidentId})/troubleshootingentries`,
      {
        Title: entry.Title,
        Description: entry.Description,
        EntryType: entry.EntryType || "Note",
      }
    );
  }

  async getIncidentTroubleshootingEntries(incidentId: number): Promise<TroubleshootingEntry[]> {
    const result = await this.request<{ value: TroubleshootingEntry[] }>(
      "GET",
      `/api/cert/incidents(${incidentId})/troubleshootingentries`
    );
    return result.value || [];
  }
}
