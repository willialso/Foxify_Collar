import { DeribitConnector, DeribitOrderRequest } from "@foxify/connectors";

export type VenueOrderRequest = DeribitOrderRequest;

export interface VenueExecutor {
  venue: string;
  placeOrder(request: VenueOrderRequest): Promise<unknown>;
}

export class ExecutionRegistry {
  private executors = new Map<string, VenueExecutor>();

  register(executor: VenueExecutor): void {
    this.executors.set(executor.venue, executor);
  }

  async placeOrder(venue: string, request: VenueOrderRequest): Promise<unknown> {
    const executor = this.executors.get(venue);
    if (!executor) {
      throw new Error(`Missing executor for venue: ${venue}`);
    }
    return executor.placeOrder(request);
  }
}

export function createDeribitExecutor(connector: DeribitConnector): VenueExecutor {
  return {
    venue: "deribit",
    placeOrder: (request) => connector.placeOrder(request)
  };
}
