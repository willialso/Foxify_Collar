export class MockDeribitConnector {
  private instruments: any[] = [];
  private tickers = new Map<string, any>();
  private orderBooks = new Map<string, any>();
  private orderResponses = new Map<string, any>();

  setInstruments(instruments: any[]): void {
    this.instruments = instruments;
  }

  setTicker(instrument: string, ticker: any): void {
    this.tickers.set(instrument, ticker);
  }

  setOrderBook(instrument: string, book: any): void {
    this.orderBooks.set(instrument, book);
  }

  setOrderResponse(instrument: string, response: any): void {
    this.orderResponses.set(instrument, response);
  }

  async listInstruments(asset: string): Promise<any> {
    return {
      result: this.instruments.filter((inst) => inst.base_currency === asset)
    };
  }

  async getIndexPrice(_index: string): Promise<any> {
    return {
      result: {
        index_price: 100000
      }
    };
  }

  async getTicker(instrument: string): Promise<any> {
    const ticker = this.tickers.get(instrument);
    if (!ticker) {
      throw new Error(`No mock ticker for ${instrument}`);
    }
    return { result: ticker };
  }

  async getOrderBook(instrument: string): Promise<any> {
    const book = this.orderBooks.get(instrument);
    if (!book) {
      throw new Error(`No mock order book for ${instrument}`);
    }
    return { result: book };
  }

  async buy(params: any): Promise<any> {
    const response = this.orderResponses.get(params.instrument_name);
    if (!response) {
      throw new Error(`No mock order response for ${params.instrument_name}`);
    }
    return response;
  }

  async sell(params: any): Promise<any> {
    const response = this.orderResponses.get(params.instrument_name);
    if (!response) {
      throw new Error(`No mock order response for ${params.instrument_name}`);
    }
    return response;
  }
}

export function createMockDeribitWithDefaults(): MockDeribitConnector {
  const mock = new MockDeribitConnector();

  mock.setInstruments([
    {
      instrument_name: "BTC-1FEB25-88000-P",
      base_currency: "BTC",
      option_type: "put",
      strike: 88000,
      expiration_timestamp: Date.now() + 24 * 60 * 60 * 1000,
      open_interest: 10
    },
    {
      instrument_name: "BTC-1FEB25-84000-P",
      base_currency: "BTC",
      option_type: "put",
      strike: 84000,
      expiration_timestamp: Date.now() + 24 * 60 * 60 * 1000,
      open_interest: 15
    }
  ]);

  mock.setTicker("BTC-1FEB25-88000-P", {
    mark_price: 0.015,
    mark_iv: 0.6,
    best_ask_price: 0.016,
    best_bid_price: 0.014
  });

  mock.setOrderResponse("BTC-1FEB25-88000-P", {
    result: {
      order: { order_id: "test_order_001" },
      filled_amount: 0.5,
      average_price: 0.016
    }
  });

  return mock;
}
