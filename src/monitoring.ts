import type { FastifyInstance } from "fastify";
import Decimal from "decimal.js";

export type MonitoringDeps = {
  getQuoteCacheSize: () => number;
  getIvLadderReady: () => boolean;
  getCoverageCount: () => number;
  getPremiumCollectedUsdc: () => Decimal;
  getAverageExecutionTimeMs: () => number;
};

export function setupMonitoring(app: FastifyInstance, deps: MonitoringDeps): void {
  app.get("/metrics", async () => {
    return {
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      cpuUsage: process.cpuUsage(),
      quoteCacheSize: deps.getQuoteCacheSize(),
      ivLadderReady: deps.getIvLadderReady(),
      totalCoveragesActivated: deps.getCoverageCount(),
      totalPremiumCollectedUsdc: deps.getPremiumCollectedUsdc().toFixed(2),
      averageExecutionTimeMs: deps.getAverageExecutionTimeMs()
    };
  });

  app.addHook("onRequest", async (request, _reply) => {
    request.log.info({
      method: request.method,
      url: request.url,
      ip: request.ip,
      userAgent: request.headers["user-agent"],
      requestId: request.id
    });
  });

  app.addHook("onResponse", async (request, reply) => {
    request.log.info({
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      responseTime: reply.getResponseTime(),
      requestId: request.id
    });
  });
}
