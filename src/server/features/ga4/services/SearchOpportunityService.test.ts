import { beforeEach, describe, expect, it, vi } from "vitest";
import { GscNotConnectedError } from "@/server/lib/gscErrors";
import { makeGa4ReportResult } from "./ga4-test-fixtures";
import { SearchOpportunityService } from "./SearchOpportunityService";

const mocks = vi.hoisted(() => ({
  getGa4Connection: vi.fn(),
  getGscConnection: vi.fn(),
  getPerformance: vi.fn(),
  runGa4Report: vi.fn(),
}));

vi.mock("@/server/features/ga4/repositories/Ga4ConnectionRepository", () => ({
  Ga4ConnectionRepository: { getByProjectId: mocks.getGa4Connection },
}));
vi.mock("@/server/features/gsc/services/GscService", () => ({
  GscService: {
    getConnection: mocks.getGscConnection,
    getPerformance: mocks.getPerformance,
  },
}));
vi.mock("@/server/features/ga4/services/Ga4ReportingService", () => ({
  Ga4ReportingService: { runReport: mocks.runGa4Report },
  resolveGa4DateRange: vi.fn(),
}));

const ga4Result = makeGa4ReportResult({
  status: "ok" as const,
  source: {
    provider: "google_analytics" as const,
    propertyId: "properties/123",
    propertyDisplayName: "Example",
  },
  request: {
    requestedDateRange: { startDate: "2026-07-07", endDate: "2026-08-03" },
    resolvedDateRange: { startDate: "2026-07-07", endDate: "2026-08-03" },
    propertyTimeZone: "America/New_York",
    currencyCode: "USD",
    channel: "organic_search" as const,
    limit: 1_000,
    offset: 0,
  },
  rows: [
    {
      hostName: "example.com",
      landingPage: "/High-Value/?utm_source=x",
      sessions: 100,
      activeUsers: 90,
      engagedSessions: 80,
      engagementRate: 0.8,
      keyEvents: 10,
      sessionKeyEventRate: 0.1,
      transactions: 2,
      purchaseRevenue: 500,
    },
    {
      hostName: "example.com",
      landingPage: "/other/",
      sessions: 10,
      activeUsers: 9,
      engagedSessions: 5,
      engagementRate: 0.5,
      keyEvents: 1,
      sessionKeyEventRate: 0.02,
      transactions: 0,
      purchaseRevenue: 0,
    },
  ],
  rowCount: 2,
  totalRowCount: 2,
  pageInfo: { offset: 0, limit: 1_000, hasMore: false, nextOffset: null },
  reportMetadata: {
    dataLossFromOtherRow: false,
    subjectToThresholding: false,
    sampling: [],
    restrictedMetrics: [],
    emptyReason: null,
    hasLimitedData: false,
  },
  quota: null,
  warnings: [],
});

describe("SearchOpportunityService", () => {
  beforeEach(() => {
    mocks.getGa4Connection.mockResolvedValue({
      propertyTimeZone: "America/New_York",
    });
    mocks.getGscConnection.mockResolvedValue({
      siteUrl: "https://example.com/",
    });
    mocks.runGa4Report.mockImplementation(async (input) =>
      input.kind === "key_events"
        ? makeGa4ReportResult({
            ...ga4Result,
            rows: [
              {
                hostName: "example.com",
                landingPage: "/High-Value/",
                eventName: "lead_submitted",
                keyEvents: 10,
              },
              {
                hostName: "example.com",
                landingPage: "/other/",
                eventName: "run_address_start",
                keyEvents: 100,
              },
            ],
          })
        : ga4Result,
    );
  });

  it("normalizes URLs, scores joined candidates, and leaves unmatched pages unscored", async () => {
    mocks.getPerformance.mockResolvedValue({
      siteUrl: "https://example.com/",
      request: {},
      rows: [
        {
          keys: ["https://EXAMPLE.com/High-Value/?ref=gsc"],
          clicks: 10,
          impressions: 1_000,
          ctr: 0.01,
          position: 6,
        },
        {
          keys: ["https://example.com/other"],
          clicks: 5,
          impressions: 500,
          ctr: 0.01,
          position: 12,
        },
        {
          keys: ["https://example.com/no-analytics"],
          clicks: 1,
          impressions: 2_000,
          ctr: 0.0005,
          position: 8,
        },
        {
          keys: ["https://example.com/top-result"],
          clicks: 100,
          impressions: 3_000,
          ctr: 0.03,
          position: 2,
        },
      ],
    });
    const result = await SearchOpportunityService.getOpportunities(
      { projectId: "project_1" },
      { now: new Date("2026-08-06T12:00:00Z") },
    );

    expect(mocks.getPerformance).toHaveBeenCalledWith(
      expect.objectContaining({
        startDate: "2026-07-07",
        endDate: "2026-08-03",
        dimensions: ["page"],
        rowLimit: 1_000,
      }),
    );
    expect(mocks.runGa4Report).toHaveBeenCalledWith(
      expect.objectContaining({
        startDate: "2026-07-07",
        endDate: "2026-08-03",
        kind: "landing_pages",
      }),
    );
    expect(result.totalCandidateRows).toBe(3);
    expect(result.coverage).toMatchObject({
      matchedRows: 2,
      unmatchedGscRows: 1,
    });
    expect(result.rows[0]).toMatchObject({
      page: "https://EXAMPLE.com/High-Value/?ref=gsc",
      normalizedPage: "example.com/High-Value",
      joinStatus: "joined",
      score: 100,
    });
    expect(
      result.rows.find((row) => row.joinStatus === "gsc_only"),
    ).toMatchObject({
      ga4: null,
      score: null,
      scoreComponents: null,
    });
    expect(result.scoring.businessValueMetric).toBe(
      "leadOrPurchaseEventsPerSession",
    );
    expect(result.warnings).toContain("source_time_zones_differ");
  });

  it("does not promote engagement or a tool start to business value", async () => {
    mocks.getPerformance.mockResolvedValue({
      siteUrl: "https://example.com/",
      request: {},
      rows: [
        {
          keys: ["https://example.com/other"],
          clicks: 1,
          impressions: 100,
          ctr: 0.01,
          position: 10,
        },
      ],
    });

    const result = await SearchOpportunityService.getOpportunities({
      projectId: "project_1",
    });
    expect(result.rows[0].leadOrPurchaseEvents).toBe(0);
    expect(result.rows[0].scoreComponents?.businessValue).toBe(0);
    expect(result.scoring).toMatchObject({
      engagementFallback: false,
      businessValueMetric: "leadOrPurchaseEventsPerSession",
    });
  });

  it("anchors the shared default range to the GA4 property date", async () => {
    mocks.getGa4Connection.mockResolvedValue({
      propertyTimeZone: "America/Los_Angeles",
    });
    mocks.getPerformance.mockResolvedValue({
      siteUrl: "https://example.com/",
      request: {},
      rows: [],
    });

    await SearchOpportunityService.getOpportunities(
      { projectId: "project_1" },
      { now: new Date("2026-08-06T01:00:00Z") },
    );

    expect(mocks.getPerformance).toHaveBeenCalledWith(
      expect.objectContaining({
        startDate: "2026-07-06",
        endDate: "2026-08-02",
      }),
    );
    expect(mocks.runGa4Report).toHaveBeenCalledWith(
      expect.objectContaining({
        startDate: "2026-07-06",
        endDate: "2026-08-02",
      }),
    );
  });

  it("fails before querying GA4 when Search Console is not connected", async () => {
    mocks.getGscConnection.mockResolvedValue(null);
    await expect(
      SearchOpportunityService.getOpportunities({ projectId: "project_1" }),
    ).rejects.toBeInstanceOf(GscNotConnectedError);
    expect(mocks.getPerformance).not.toHaveBeenCalled();
    expect(mocks.runGa4Report).not.toHaveBeenCalled();
  });
  const onePage = () =>
    mocks.getPerformance.mockResolvedValue({
      siteUrl: "https://example.com/",
      rows: [
        {
          keys: ["https://example.com/other"],
          clicks: 1,
          impressions: 100,
          ctr: 0.01,
          position: 10,
        },
      ],
    });
  it("preserves missing metrics and declines scoring without a session denominator", async () => {
    onePage();
    mocks.runGa4Report.mockImplementation(async ({ kind }) =>
      makeGa4ReportResult({
        ...ga4Result,
        rows:
          kind === "landing_pages"
            ? [{ hostName: "example.com", landingPage: "/other", keyEvents: 0 }]
            : [],
        totalRowCount: kind === "landing_pages" ? 1 : 0,
      }),
    );
    const result = await SearchOpportunityService.getOpportunities({
      projectId: "project_1",
    });
    expect(result.rows[0]).toMatchObject({
      ga4: { sessions: null, activeUsers: null, keyEvents: 0 },
      score: null,
    });
  });
  it.each(["truncated", "thresholded", "missing count"])(
    "does not infer zero outcomes from %s evidence",
    async (failure) => {
      onePage();
      mocks.runGa4Report.mockImplementation(async ({ kind }) =>
        kind === "landing_pages"
          ? ga4Result
          : makeGa4ReportResult({
              ...ga4Result,
              rows:
                failure === "missing count"
                  ? [
                      {
                        hostName: "example.com",
                        landingPage: "/other",
                        eventName: "lead_submitted",
                        keyEvents: null,
                      },
                    ]
                  : [],
              totalRowCount:
                failure === "truncated"
                  ? 1001
                  : failure === "missing count"
                    ? 1
                    : 0,
              reportMetadata: {
                ...ga4Result.reportMetadata,
                hasLimitedData: failure === "thresholded",
              },
            }),
      );
      const result = await SearchOpportunityService.getOpportunities({
        projectId: "project_1",
      });
      expect(result.rows[0].leadOrPurchaseEvents).toBeNull();
      expect(result.rows[0].score).toBeNull();
    },
  );
  it("does not overwrite colliding analytics URLs or invent deduplicated users", async () => {
    onePage();
    mocks.runGa4Report.mockImplementation(async ({ kind }) =>
      kind === "landing_pages"
        ? makeGa4ReportResult({
            ...ga4Result,
            rows: [
              ga4Result.rows[1],
              { ...ga4Result.rows[1], landingPage: "/other?ref=x" },
            ],
          })
        : makeGa4ReportResult({ ...ga4Result, rows: [], totalRowCount: 0 }),
    );
    const result = await SearchOpportunityService.getOpportunities({
      projectId: "project_1",
    });
    expect(result.rows[0]).toMatchObject({ ga4: null, score: null });
    expect(result.coverage.ambiguousGa4Pages).toBe(1);
    expect(result.warnings).toContain(
      "ambiguous_normalized_ga4_pages_unjoined",
    );
  });
  it("keeps different hosts and path case distinct", async () => {
    mocks.getPerformance.mockResolvedValue({
      siteUrl: "https://example.com/",
      rows: ["https://www.example.com/other", "https://example.com/Other"].map(
        (page) => ({
          keys: [page],
          clicks: 1,
          impressions: 100,
          ctr: 0.01,
          position: 10,
        }),
      ),
    });
    const result = await SearchOpportunityService.getOpportunities({
      projectId: "project_1",
    });
    expect(result.coverage.matchedRows).toBe(0);
    expect(result.rows.every((row) => row.ga4 === null)).toBe(true);
  });
});
