export interface RazorpaySuccessResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

export interface RazorpayCheckoutOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description?: string;
  prefill?: { name?: string; email?: string };
  notes?: Record<string, string>;
  handler: (response: RazorpaySuccessResponse) => void;
  modal?: { ondismiss?: () => void };
}

interface RazorpayCheckoutInstance {
  open(options: RazorpayCheckoutOptions): void;
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayCheckoutOptions) => { open(): void };
  }
}

const CHECKOUT_SCRIPT_SRC = "https://checkout.razorpay.com/v1/checkout.js";

let loadPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("Razorpay checkout requires a browser"));
  if (window.Razorpay) return Promise.resolve();
  if (loadPromise) return loadPromise;
  loadPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = CHECKOUT_SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      loadPromise = null;
      reject(new Error("Failed to load the Razorpay checkout script"));
    };
    document.body.appendChild(script);
  });
  return loadPromise;
}

/** Lazily loads Razorpay's own Checkout.js (never bundled — it must be fetched live from Razorpay so it
 *  always reflects their current fraud/3DS rules) and returns a thin `open()` wrapper around it. */
export async function loadRazorpayCheckout(): Promise<RazorpayCheckoutInstance> {
  await loadScript();
  if (!window.Razorpay) throw new Error("Razorpay checkout script did not initialize");
  const Razorpay = window.Razorpay;
  return {
    open(options: RazorpayCheckoutOptions) {
      new Razorpay(options).open();
    }
  };
}
