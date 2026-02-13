#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { IcMClient } from "./icm-client.js";
import { IcMConfig } from "./types.js";

const config: IcMConfig = {
  apiBaseUrl: process.env.ICM_API_BASE_URL || "https://icm.ad.msft.net",
  tenantId: process.env.AZURE_TENANT_ID || "",
  clientId: process.env.AZURE_CLIENT_ID || "",
  apiScope: process.env.ICM_API_SCOPE || "api://icmmcpapi-prod/mcp.tools",
};

const icmClient = new IcMClient(config);

const server = new McpServer({
  name: "icm-mcp-server",
  version: "1.0.0",
});

// Tool: Query/Search Incidents
server.tool(
  "query_incidents",
  "Search and filter IcM incidents by team, severity, status, date range, or custom OData filter",
  {
    teamId: z.string().optional().describe("Owning team ID to filter by"),
    severity: z.number().min(1).max(4).optional().describe("Severity level (1=Critical, 2=High, 3=Medium, 4=Low)"),
    status: z.string().optional().describe("Incident status filter (e.g. Active, Mitigated, Resolved)"),
    createdAfter: z.string().optional().describe("Filter incidents created after this date (ISO 8601 format)"),
    createdBefore: z.string().optional().describe("Filter incidents created before this date (ISO 8601 format)"),
    top: z.number().min(1).max(100).optional().describe("Maximum number of results to return (default: 25)"),
    filter: z.string().optional().describe("Custom OData $filter expression for advanced queries"),
  },
  async (params) => {
    try {
      const incidents = await icmClient.queryIncidents(params);
      const summary = incidents.map((inc) => ({
        Id: inc.Id,
        Title: inc.Title,
        Severity: inc.Severity,
        Status: inc.Status,
        OwningTeam: inc.OwningTeamId,
        Owner: inc.OwningContactAlias,
        Created: inc.Source?.CreateDate,
        Mitigated: inc.Mitigated,
        Resolved: inc.Resolved,
      }));
      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${incidents.length} incident(s):\n\n${JSON.stringify(summary, null, 2)}`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text" as const, text: `Error querying incidents: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Get Incident Details
server.tool(
  "get_incident",
  "Get detailed information about a specific IcM incident by its ID",
  {
    incidentId: z.number().describe("The IcM incident ID"),
  },
  async ({ incidentId }) => {
    try {
      const incident = await icmClient.getIncident(incidentId);
      return {
        content: [
          {
            type: "text" as const,
            text: `Incident ${incidentId} details:\n\n${JSON.stringify(incident, null, 2)}`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text" as const, text: `Error getting incident: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Create Incident
server.tool(
  "create_incident",
  "Create a new IcM incident",
  {
    title: z.string().describe("Incident title"),
    severity: z.number().min(1).max(4).describe("Severity (1=Critical, 2=High, 3=Medium, 4=Low)"),
    owningTeamId: z.string().describe("The owning team ID for the incident"),
    description: z.string().optional().describe("Detailed description of the incident"),
    owningContactAlias: z.string().optional().describe("Alias of the person who should own the incident"),
    impactStartDate: z.string().optional().describe("When the impact started (ISO 8601)"),
    keywords: z.string().optional().describe("Keywords for the incident"),
    environment: z.string().optional().describe("Environment where the issue occurred"),
    deviceGroup: z.string().optional().describe("Device group affected"),
    deviceName: z.string().optional().describe("Specific device name affected"),
  },
  async (params) => {
    try {
      const incident = await icmClient.createIncident({
        Title: params.title,
        Severity: params.severity,
        OwningTeamId: params.owningTeamId,
        Description: params.description,
        OwningContactAlias: params.owningContactAlias,
        ImpactStartDate: params.impactStartDate || new Date().toISOString(),
        Keywords: params.keywords,
        RaisingLocation: {
          Environment: params.environment,
          DeviceGroup: params.deviceGroup,
          DeviceName: params.deviceName,
        },
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Incident created successfully!\n\nIncident ID: ${incident.Id}\nTitle: ${incident.Title}\nSeverity: ${incident.Severity}\nStatus: ${incident.Status}`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text" as const, text: `Error creating incident: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Update Incident
server.tool(
  "update_incident",
  "Update an existing IcM incident (severity, status, owner, mitigation)",
  {
    incidentId: z.number().describe("The IcM incident ID to update"),
    severity: z.number().min(1).max(4).optional().describe("New severity level"),
    status: z.string().optional().describe("New status (e.g. Active, Mitigated, Resolved)"),
    owningContactAlias: z.string().optional().describe("New owner alias"),
    mitigationData: z.string().optional().describe("Mitigation details/notes"),
    mitigated: z.boolean().optional().describe("Mark incident as mitigated"),
    resolved: z.boolean().optional().describe("Mark incident as resolved"),
  },
  async (params) => {
    try {
      const update: any = {};
      if (params.severity !== undefined) update.Severity = params.severity;
      if (params.status !== undefined) update.Status = params.status;
      if (params.owningContactAlias !== undefined) update.OwningContactAlias = params.owningContactAlias;
      if (params.mitigationData !== undefined) update.MitigationData = params.mitigationData;
      if (params.mitigated !== undefined) update.Mitigated = params.mitigated;
      if (params.resolved !== undefined) update.Resolved = params.resolved;

      await icmClient.updateIncident(params.incidentId, update);
      return {
        content: [
          {
            type: "text" as const,
            text: `Incident ${params.incidentId} updated successfully.\nUpdated fields: ${Object.keys(update).join(", ")}`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text" as const, text: `Error updating incident: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Add Troubleshooting Entry
server.tool(
  "add_troubleshooting_entry",
  "Add a troubleshooting note or entry to an IcM incident",
  {
    incidentId: z.number().describe("The IcM incident ID"),
    title: z.string().describe("Title of the troubleshooting entry"),
    description: z.string().describe("Detailed content of the troubleshooting entry"),
    entryType: z.string().optional().describe("Entry type (default: 'Note')"),
  },
  async (params) => {
    try {
      await icmClient.addTroubleshootingEntry({
        IncidentId: params.incidentId,
        Title: params.title,
        Description: params.description,
        EntryType: params.entryType,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Troubleshooting entry added to incident ${params.incidentId}.\nTitle: ${params.title}`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text" as const, text: `Error adding entry: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Get Troubleshooting Entries
server.tool(
  "get_troubleshooting_entries",
  "Get all troubleshooting entries/notes for an IcM incident",
  {
    incidentId: z.number().describe("The IcM incident ID"),
  },
  async ({ incidentId }) => {
    try {
      const entries = await icmClient.getIncidentTroubleshootingEntries(incidentId);
      return {
        content: [
          {
            type: "text" as const,
            text: `Troubleshooting entries for incident ${incidentId}:\n\n${JSON.stringify(entries, null, 2)}`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text" as const, text: `Error getting entries: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("IcM MCP Server started successfully");
}

main().catch((error) => {
  console.error("Fatal error starting IcM MCP server:", error);
  process.exit(1);
});
