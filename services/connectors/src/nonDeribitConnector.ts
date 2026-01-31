export interface ExternalMarketConnector {
  getIndexPrice(asset: string): Promise<number | null>;
  getOrderBook(symbol: string): Promise<{ bids: Array<[number, number]>; asks: Array<[number, number]> } | null>;
}

export class NonDeribitConnector implements ExternalMarketConnector {
  async getIndexPrice(_asset: string): Promise<number | null> {
    return null;
  }

  async getOrderBook(_symbol: string): Promise<{ bids: Array<[number, number]>; asks: Array<[number, number]> } | null> {
    return null;
  }
}
