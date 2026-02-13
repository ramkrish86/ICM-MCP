import { AccessToken } from "@azure/identity";

export interface IcMConfig {
  apiBaseUrl: string;
  tenantId: string;
  clientId: string;
  apiScope: string;
}

export interface IcMIncident {
  Id?: number;
  Title: string;
  Severity: number;
  Status?: string;
  OwningTeamId: string;
  OwningContactAlias?: string;
  ImpactStartDate?: string;
  Description?: string;
  Keywords?: string;
  Source?: {
    CreateDate?: string;
    IncidentId?: string;
  };
  RaisingLocation?: {
    Environment?: string;
    DeviceGroup?: string;
    DeviceName?: string;
    ServiceInstanceId?: string;
  };
  RoutingId?: string;
  CorrelationId?: string;
  HitCount?: number;
  Mitigated?: boolean;
  MitigationData?: string;
  Resolved?: boolean;
  ResolvedDate?: string;
  TsgId?: string;
  TsgOutput?: string;
}

export interface IcMQueryParams {
  teamId?: string;
  severity?: number;
  status?: string;
  createdAfter?: string;
  createdBefore?: string;
  top?: number;
  filter?: string;
}

export interface TroubleshootingEntry {
  IncidentId: number;
  Title: string;
  Description: string;
  EntryType?: string;
}

export interface IncidentUpdate {
  Severity?: number;
  Status?: string;
  OwningContactAlias?: string;
  MitigationData?: string;
  Mitigated?: boolean;
  Resolved?: boolean;
}
