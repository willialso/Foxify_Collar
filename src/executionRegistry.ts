import { DeribitConnector } from "@foxify/connectors";

export type VenueOrderRequest = {
  instrument: string;
  amount: number;
  side: "buy" | "sell";
  type: "market" | "limit";
  price?: number;
};

export type VenueExecutor = {
  placeOrder: (request: VenueOrderRequest) => Promise<any>;
};

export class ExecutionRegistry {
  private executors = new Map<string, VenueExecutor>();

  register(venue: string, executor: VenueExecutor): void {
    this.executors.set(venue, executor);
  }

  async placeOrder(venue: string, request: VenueOrderRequest): Promise<any> {
    const executor = this.executors.get(venue);

    if (!executor) {
      throw new Error(`Venue not registered: ${venue}`);
    }

    if (!request.instrument || !request.amount || !request.side || !request.type) {
      throw new Error("Invalid order request: missing required fields");
    }

    if (request.type === "limit" && (request.price === undefined || request.price === null)) {
      throw new Error("Limit orders require price");
    }

    return await executor.placeOrder(request);
  }
}

export function createDeribitExecutor(connector: DeribitConnector): VenueExecutor {
  return {
    async placeOrder(request: VenueOrderRequest): Promise<any> {
      const params: Record<string, unknown> = {
        instrument_name: request.instrument,
        amount: request.amount,
        type: request.type
      };

      if (request.type === "limit") {
        if (!request.price) {
          throw new Error("Limit order missing price");
        }
        params.price = request.price;
      }

      if (request.side === "buy") {
        return await connector.buy(params);
      }
      return await connector.sell(params);
    }
  };
}
