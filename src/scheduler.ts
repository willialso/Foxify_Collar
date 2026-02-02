export function runAutoRenewJob(
  intervalMs: number,
  callback: () => void | Promise<void>
): () => void {
  const timer = setInterval(async () => {
    try {
      await callback();
    } catch (error) {
      console.error("Auto-renew job error:", error);
    }
  }, intervalMs);

  return () => clearInterval(timer);
}
