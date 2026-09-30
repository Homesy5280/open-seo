import { GscService } from "@/server/features/gsc/services/GscService";
import { GscNotConnectedError } from "@/server/lib/gscErrors";
import {
  Ga4ReportingService,
  resolveGa4DateRange,
} from "@/server/features/ga4/services/Ga4ReportingService";
import { Ga4ReportError } from "@/server/lib/ga4Errors";
import { Ga4ConnectionRepository } from "@/server/features/ga4/repositories/Ga4ConnectionRepository";
import { ga4DateInTimeZone, shiftGa4Date } from "./Ga4Dates";

type SearchOpportunityInput = {
  projectId: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
};

type Candidate = {
  page: string;
  normalizedPage: string | null;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  joinStatus: "joined" | "gsc_only";
  ga4: {
    sessions: number | null;
    activeUsers: number | null;
    engagedSessions: number | null;
    engagementRate: number | null;
    keyEvents: number | null;
    sessionKeyEventRate: number | null;
    transactions: number | null;
    purchaseRevenue: number | null;
  } | null;
  leadOrPurchaseKeyEvents: number | null;
  score: number | null;
  scoreComponents: {
    demand: number;
    businessValue: number;
    reachability: number;
  } | null;
};

function resolveCombinedDates(
  input: Pick<SearchOpportunityInput, "startDate" | "endDate">,
  propertyTimeZone: string,
  now: Date,
) {
  if (!input.startDate && !input.endDate) {
    const endDate = shiftGa4Date(ga4DateInTimeZone(now, propertyTimeZone), -3);
    return {
      startDate: shiftGa4Date(endDate, -27),
      endDate,
    };
  }
  return resolveGa4DateRange(input, propertyTimeZone, now).resolvedDateRange;
}

function normalizePageKey(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "(not set)") return null;
  try {
    const url = new URL(
      trimmed.includes("://") ? trimmed : `https://${trimmed}`,
    );
    if (!["https:", "http:"].includes(url.protocol) || !url.hostname)
      return null;
    let host = url.hostname.toLowerCase();
    const defaultPort =
      (url.protocol === "http:" && url.port === "80") ||
      (url.protocol === "https:" && url.port === "443");
    if (url.port && !defaultPort) host += `:${url.port}`;
    let path = url.pathname || "/";
    if (path.length > 1) path = path.replace(/\/+$/, "");
    return `${host}${path}`;
  } catch {
    return null;
  }
}

function numberField(
  row: Record<string, string | number | null>,
  name: string,
): number | null {
  const value = row[name];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function percentileRanks(values: number[]): number[] {
  if (values.length === 0) return [];
  if (values.length === 1) return [values[0] > 0 ? 1 : 0];
  return values.map((value) => {
    const lower = values.filter((candidate) => candidate < value).length;
    return lower / (values.length - 1);
  });
}

function roundComponent(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

async function getOpportunities(
  input: SearchOpportunityInput,
  opts: { now?: Date } = {},
) {
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Ga4ReportError(
      "validation_error",
      "limit must be an integer from 1 to 100.",
    );
  }
  const [ga4Connection, gscConnection] = await Promise.all([
    Ga4ConnectionRepository.getByProjectId(input.projectId),
    GscService.getConnection(input.projectId),
  ]);
  if (!ga4Connection) {
    throw new Ga4ReportError(
      "ga4_not_connected",
      "Google Analytics is not connected for this project.",
    );
  }
  if (!gscConnection) throw new GscNotConnectedError(input.projectId);

  const now = opts.now ?? new Date();
  const dates = resolveCombinedDates(
    input,
    ga4Connection.propertyTimeZone,
    now,
  );
  const gsc = await GscService.getPerformance({
    projectId: input.projectId,
    dimensions: ["page"],
    startDate: dates.startDate,
    endDate: dates.endDate,
    rowLimit: 1_000,
    startRow: 0,
    type: "web",
    dataState: "final",
  });
  const ga4 = await Ga4ReportingService.runReport({
    projectId: input.projectId,
    kind: "landing_pages",
    startDate: dates.startDate,
    endDate: dates.endDate,
    limit: 1_000,
    offset: 0,
    channel: "organic_search",
  });

  // Event counts are analytics evidence, not deduplicated leads or CRM outcomes.
  // Tool starts, phone/email clicks and engagement are intentionally excluded.
  const outcomeEventNames = [
    "generate_lead",
    "lead_submitted",
    "qualify_lead",
    "close_convert_lead",
    "purchase",
  ];
  const events = await Ga4ReportingService.runReport({
    projectId: input.projectId,
    kind: "key_events",
    breakdown: "event_and_landing_page",
    ...dates,
    limit: 1_000,
    offset: 0,
    channel: "organic_search",
  });
  const outcomeRowsTruncated =
    events.pageInfo.hasMore || events.totalRowCount > events.rows.length;
  const eventsComplete =
    !outcomeRowsTruncated && !events.reportMetadata.hasLimitedData;
  const outcomesByPage = new Map<string, number | null>();
  let invalidOutcomeRows = 0;
  for (const row of events.rows) {
    if (!outcomeEventNames.includes(String(row.eventName))) continue;
    const key =
      typeof row.hostName === "string" &&
      row.hostName.length > 0 &&
      typeof row.landingPage === "string" &&
      row.landingPage.startsWith("/")
        ? normalizePageKey(`${row.hostName}${row.landingPage}`)
        : null;
    if (!key) {
      invalidOutcomeRows += 1;
      continue;
    }
    const count = numberField(row, "keyEvents");
    if (count === null) invalidOutcomeRows += 1;
    const previous = outcomesByPage.get(key);
    outcomesByPage.set(
      key,
      count === null || previous === null ? null : (previous ?? 0) + count,
    );
  }
  const ga4ByPage = new Map<string, Record<string, string | number | null>>();
  const ambiguousGa4Pages = new Set<string>();
  let invalidGa4Rows = 0;
  for (const row of ga4.rows) {
    const host = typeof row.hostName === "string" ? row.hostName : "";
    const landing = typeof row.landingPage === "string" ? row.landingPage : "";
    const key =
      host && landing.startsWith("/")
        ? normalizePageKey(`${host}${landing}`)
        : null;
    if (!key) {
      invalidGa4Rows += 1;
      continue;
    }
    if (ga4ByPage.has(key) || ambiguousGa4Pages.has(key)) {
      ambiguousGa4Pages.add(key);
      ga4ByPage.delete(key);
    } else ga4ByPage.set(key, row);
  }

  const gscPageCounts = new Map<string, number>();
  for (const row of gsc.rows) {
    const key = normalizePageKey(row.keys?.[0] ?? "");
    if (key) gscPageCounts.set(key, (gscPageCounts.get(key) ?? 0) + 1);
  }
  const ambiguousGscPages = [...gscPageCounts.values()].filter(
    (count) => count > 1,
  ).length;
  const candidates: Candidate[] = gsc.rows
    .filter((row) => row.position >= 4 && row.position <= 20)
    .map((row) => {
      const page = row.keys?.[0] ?? "";
      const normalizedPage = normalizePageKey(page);
      const analytics =
        normalizedPage && gscPageCounts.get(normalizedPage) === 1
          ? ga4ByPage.get(normalizedPage)
          : undefined;
      return {
        page,
        normalizedPage,
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
        position: row.position,
        joinStatus: analytics ? "joined" : "gsc_only",
        ga4: analytics
          ? {
              sessions: numberField(analytics, "sessions"),
              activeUsers: numberField(analytics, "activeUsers"),
              engagedSessions: numberField(analytics, "engagedSessions"),
              engagementRate: numberField(analytics, "engagementRate"),
              keyEvents: numberField(analytics, "keyEvents"),
              sessionKeyEventRate: numberField(
                analytics,
                "sessionKeyEventRate",
              ),
              transactions: numberField(analytics, "transactions"),
              purchaseRevenue:
                typeof analytics.purchaseRevenue === "number"
                  ? analytics.purchaseRevenue
                  : null,
            }
          : null,
        leadOrPurchaseKeyEvents:
          normalizedPage &&
          analytics &&
          eventsComplete &&
          invalidOutcomeRows === 0
            ? outcomesByPage.has(normalizedPage)
              ? outcomesByPage.get(normalizedPage)!
              : 0
            : null,
        score: null,
        scoreComponents: null,
      } satisfies Candidate;
    });

  const joined = candidates.filter(
    (
      candidate,
    ): candidate is Candidate & { ga4: NonNullable<Candidate["ga4"]> } =>
      candidate.ga4 !== null,
  );
  const pageEvidenceComplete =
    !ga4.pageInfo.hasMore &&
    ga4.totalRowCount <= ga4.rows.length &&
    gsc.rows.length < 1_000;
  const scored = joined.filter(
    (candidate) =>
      candidate.ga4.sessions !== null &&
      candidate.ga4.sessions > 0 &&
      candidate.leadOrPurchaseKeyEvents !== null &&
      pageEvidenceComplete &&
      !ga4.reportMetadata.hasLimitedData,
  );
  const demand = percentileRanks(
    scored.map((candidate) => Math.log1p(candidate.impressions)),
  );
  const outcomeRates = scored.map(
    (candidate) => candidate.leadOrPurchaseKeyEvents! / candidate.ga4.sessions!,
  );
  const businessValue = percentileRanks(outcomeRates);
  const reachability = percentileRanks(
    scored.map((candidate) => 20 - candidate.position),
  );
  scored.forEach((candidate, index) => {
    const components = {
      demand: roundComponent(demand[index] ?? 0),
      businessValue:
        outcomeRates[index] === 0
          ? 0
          : roundComponent(businessValue[index] ?? 0),
      reachability: roundComponent(reachability[index] ?? 0),
    };
    candidate.scoreComponents = components;
    candidate.score = Math.round(
      100 *
        (0.5 * components.demand +
          0.3 * components.businessValue +
          0.2 * components.reachability),
    );
  });
  candidates.sort((a, b) => {
    if (a.score == null && b.score != null) return 1;
    if (a.score != null && b.score == null) return -1;
    return (b.score ?? 0) - (a.score ?? 0) || b.impressions - a.impressions;
  });

  const matchedRows = joined.length;
  const unmatchedGscRows = candidates.length - matchedRows;
  const returned = candidates.slice(0, limit);
  return {
    status: "ok" as const,
    source: {
      searchConsoleSiteUrl: gsc.siteUrl,
      googleAnalyticsPropertyId: ga4.source.propertyId,
      googleAnalyticsPropertyDisplayName: ga4.source.propertyDisplayName,
    },
    request: {
      dateRange: dates,
      limit,
      searchConsoleTimeZone: "America/Los_Angeles",
      googleAnalyticsTimeZone: ga4.request.propertyTimeZone,
    },
    rowCount: returned.length,
    totalCandidateRows: candidates.length,
    rows: returned,
    scoring: {
      formula:
        "round(100 * (0.5 * demand + 0.3 * businessValue + 0.2 * reachability))",
      businessValueMetric: "leadOrPurchaseKeyEventsPerSession",
      outcomeEventNames,
      outcomeMeaning:
        "GA4 key-event counts only; excludes events without key-event designation. Zero means no reported eligible key events, not no leads. Not unique leads, qualified consultations or signed clients",
      engagementFallback: false,
      scoreDataLimited:
        ga4.reportMetadata.hasLimitedData ||
        !pageEvidenceComplete ||
        !eventsComplete ||
        invalidOutcomeRows > 0,
    },
    coverage: {
      gscRowsConsidered: gsc.rows.length,
      ga4RowsConsidered: ga4.rows.length,
      matchedRows,
      unmatchedGscRows,
      unmatchedGa4Rows:
        [...ga4ByPage.keys()].filter(
          (key) => !joined.some((row) => row.normalizedPage === key),
        ).length + invalidGa4Rows,
      ambiguousGa4Pages: ambiguousGa4Pages.size,
      ambiguousGscPages,
    },
    truncated: {
      gsc: gsc.rows.length >= 1_000,
      ga4: ga4.totalRowCount > ga4.rows.length,
      outcomeEvents: outcomeRowsTruncated,
      candidates: returned.length < candidates.length,
    },
    warnings: [
      ...(!pageEvidenceComplete ? ["page_evidence_incomplete_unscored"] : []),
      ...(ambiguousGscPages ? ["ambiguous_normalized_gsc_pages_unjoined"] : []),
      ...ga4.warnings,
      ...events.warnings,
      ...(ga4.request.propertyTimeZone === "America/Los_Angeles"
        ? []
        : ["source_time_zones_differ"]),
      ...(ambiguousGa4Pages.size
        ? ["ambiguous_normalized_ga4_pages_unjoined"]
        : []),
      ...(!eventsComplete || invalidOutcomeRows
        ? ["outcome_event_evidence_incomplete"]
        : []),
    ],
    reportMetadata: ga4.reportMetadata,
    quota: events.quota ?? ga4.quota,
  };
}

export const SearchOpportunityService = { getOpportunities };
