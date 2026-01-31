export interface AlertPayload {
  type: "expiry_soon" | "auto_renewed" | "hedge_adjusted";
  message: string;
  accountId: string;
  timestamp: string;
}

export async function sendWebhookAlert(url: string, payload: AlertPayload): Promise<void> {
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}
