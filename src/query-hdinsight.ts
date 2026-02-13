import { InteractiveBrowserCredential } from "@azure/identity";

const tenantId = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const scope = "api://icmmcpapi-prod/mcp.tools";
const baseUrl = "https://icm.ad.msft.net";

const cred = new InteractiveBrowserCredential({ tenantId });

async function getToken() {
  const token = await cred.getToken(scope);
  return token.token;
}

async function queryIcM(filter: string, top: number = 100): Promise<any[]> {
  const token = await getToken();
  let allResults: any[] = [];
  let url = `${baseUrl}/api/cert/incidents?$top=${top}&$filter=${encodeURIComponent(filter)}&$orderby=${encodeURIComponent("Source/CreateDate desc")}`;

  while (url) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const err = await response.text();
      console.error(`API Error ${response.status}: ${err.substring(0, 500)}`);
      break;
    }

    const data = await response.json() as any;
    const items = data.value || [];
    allResults = allResults.concat(items);
    url = data["@odata.nextLink"] || null;

    // Re-acquire token for next page if needed
    if (url) {
      console.error(`  Fetched ${allResults.length} so far...`);
    }
  }

  return allResults;
}

// IST = UTC + 5:30. Night hours 9PM-6AM IST = 3:30PM-12:30AM UTC
function isISTNightHours(dateStr: string): boolean {
  const d = new Date(dateStr);
  const utcHour = d.getUTCHours();
  const utcMin = d.getUTCMinutes();
  const totalMinutesUTC = utcHour * 60 + utcMin;

  // 9PM IST = 15:30 UTC (930 min), 6AM IST = 00:30 UTC (30 min)
  // Night in IST: 21:00 IST to 06:00 IST = 15:30 UTC to 00:30 UTC (next day)
  // So in UTC: >= 15:30 (930 min) OR < 00:30 (30 min)
  return totalMinutesUTC >= 930 || totalMinutesUTC < 30;
}

function toIST(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

async function main() {
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const fromDate = threeMonthsAgo.toISOString();

  // HDInsight team IDs - common patterns
  const teamQueries = [
    { name: "Streaming and Store", filter: `contains(OwningTeamId, 'Streaming') or contains(OwningTeamId, 'Store')` },
    { name: "Platform", filter: `contains(OwningTeamId, 'Platform')` },
  ];

  // First, let's discover the team IDs by searching broadly for HDInsight
  console.log("=== Discovering HDInsight Team IDs ===\n");
  const hdInsightFilter = `contains(OwningTeamId, 'HDInsight') and Source/CreateDate ge ${fromDate}`;

  try {
    const allHDI = await queryIcM(hdInsightFilter, 100);
    
    // Get unique team IDs
    const teamIds = new Map<string, number>();
    for (const inc of allHDI) {
      const team = inc.OwningTeamId || "Unknown";
      teamIds.set(team, (teamIds.get(team) || 0) + 1);
    }

    console.log("HDInsight Team IDs found:");
    for (const [team, count] of [...teamIds.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${team}: ${count} incidents`);
    }

    // Filter for Streaming/Store and Platform teams
    const streamingStoreTeams = [...teamIds.keys()].filter(
      (t) => t.toLowerCase().includes("streaming") || t.toLowerCase().includes("store")
    );
    const platformTeams = [...teamIds.keys()].filter(
      (t) => t.toLowerCase().includes("platform")
    );

    console.log(`\nStreaming/Store teams: ${streamingStoreTeams.join(", ") || "None found"}`);
    console.log(`Platform teams: ${platformTeams.join(", ") || "None found"}`);

    // Now query Sev2 and Sev3 for each group
    for (const group of [
      { name: "Streaming and Store", teams: streamingStoreTeams },
      { name: "Platform", teams: platformTeams },
    ]) {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`=== ${group.name} Team(s) ===`);
      console.log(`${"=".repeat(60)}`);

      if (group.teams.length === 0) {
        console.log("No matching teams found. Trying broader search...");
        continue;
      }

      const teamFilter = group.teams
        .map((t) => `OwningTeamId eq '${t}'`)
        .join(" or ");

      for (const sev of [2, 3]) {
        const filter = `(${teamFilter}) and Severity eq ${sev} and Source/CreateDate ge ${fromDate}`;
        const incidents = await queryIcM(filter, 100);

        const nightIncidents = incidents.filter((inc) => {
          const createDate = inc.Source?.CreateDate || inc.CreateDate;
          return createDate && isISTNightHours(createDate);
        });

        console.log(`\n--- Sev${sev} ---`);
        console.log(`Total: ${incidents.length}`);
        console.log(`IST Night Hours (9PM-6AM): ${nightIncidents.length}`);
        console.log(`IST Day Hours (6AM-9PM): ${incidents.length - nightIncidents.length}`);

        if (incidents.length > 0) {
          console.log(`\nIncident details:`);
          console.log(`${"ID".padEnd(12)} ${"Severity".padEnd(10)} ${"Status".padEnd(15)} ${"Created (IST)".padEnd(25)} ${"Night?".padEnd(8)} Title`);
          console.log("-".repeat(120));
          for (const inc of incidents) {
            const createDate = inc.Source?.CreateDate || inc.CreateDate || "";
            const isNight = createDate ? isISTNightHours(createDate) : false;
            const istTime = createDate ? toIST(createDate) : "N/A";
            console.log(
              `${String(inc.Id).padEnd(12)} ${String(inc.Severity).padEnd(10)} ${(inc.Status || "").padEnd(15)} ${istTime.padEnd(25)} ${(isNight ? "YES" : "NO").padEnd(8)} ${(inc.Title || "").substring(0, 60)}`
            );
          }
        }
      }
    }

    // Summary table
    console.log(`\n${"=".repeat(60)}`);
    console.log("=== SUMMARY ===");
    console.log(`${"=".repeat(60)}`);
    console.log(`Period: ${threeMonthsAgo.toISOString().split("T")[0]} to ${new Date().toISOString().split("T")[0]}`);
    console.log(`IST Night Hours: 9:00 PM - 6:00 AM IST\n`);

  } catch (e: any) {
    console.error("Error:", e.message);
  }
}

main();
