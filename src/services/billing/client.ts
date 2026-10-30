// Billing lives on the BidveraAi website (Stripe checkout + Stripe customer portal).
// The desktop app only opens those pages in the user's browser.
export const BILLING_PAGES = {
  manage: "https://bidveraai.com/settings",
  pricing: "https://bidveraai.com/pricing",
} as const;

export type BillingPage = keyof typeof BILLING_PAGES;

export async function openBillingPage(page: BillingPage) {
  const url = BILLING_PAGES[page];
  if (window.electronAPI?.openExternal) {
    const result = await window.electronAPI.openExternal(url);
    if (result && result.success === false) throw new Error(result.message || "Could not open the browser.");
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
