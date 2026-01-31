export interface RenewalState {
  expiryIso: string;
  renewWindowMinutes: number;
}

export function shouldRenew(now: Date, state: RenewalState): boolean {
  const expiry = new Date(state.expiryIso);
  const renewAt = new Date(expiry.getTime() - state.renewWindowMinutes * 60 * 1000);
  return now >= renewAt;
}
