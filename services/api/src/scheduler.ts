import { DeribitConnector } from "@foxify/connectors";

export interface RenewJob {
  enabled: boolean;
  nextExpiryIso: string;
  renewWindowMinutes: number;
  payload: Record<string, unknown>;
}

export function shouldAutoRenew(expiryIso: string, renewWindowMinutes: number): boolean {
  const expiry = new Date(expiryIso);
  const renewAt = new Date(expiry.getTime() - renewWindowMinutes * 60 * 1000);
  return Date.now() >= renewAt.getTime();
}

export async function runAutoRenewJob(
  job: RenewJob,
  connector: DeribitConnector,
  renewFn: (payload: Record<string, unknown>) => Promise<unknown>
): Promise<unknown> {
  if (!job.enabled) return { status: "disabled" };
  if (!shouldAutoRenew(job.nextExpiryIso, job.renewWindowMinutes)) {
    return { status: "too_early" };
  }
  return renewFn(job.payload);
}
