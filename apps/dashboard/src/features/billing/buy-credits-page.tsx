"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Zap } from "lucide-react";
import { useAuth, useCurrentUser } from "../auth/auth-provider";
import { createBillingApi, type CreditPackage } from "./billing-api";
import { AccessGate } from "../admin/authorization";
import { Alert, Button, Card, PageHeader, Skeleton } from "../../components/ui";
import { loadRazorpayCheckout } from "./razorpay-checkout";

function useApi() {
  const { client } = useAuth();
  return useMemo(() => createBillingApi(client), [client]);
}

function formatMinor(amountMinor: number, currency: string): string {
  const symbol = currency === "INR" ? "₹" : `${currency} `;
  return `${symbol}${(amountMinor / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function PackageCard({
  pkg, recommended, onSelect, selecting
}: Readonly<{ pkg: CreditPackage; recommended: boolean; onSelect: () => void; selecting: boolean }>) {
  return (
    <Card className={`buy-credits-card ${recommended ? "buy-credits-card--recommended" : ""}`}>
      {recommended ? <span className="buy-credits-card__badge">Most popular</span> : null}
      <span className="buy-credits-card__icon" aria-hidden="true">
        <Zap size={18} strokeWidth={2} />
      </span>
      <p className="buy-credits-card__credits">{pkg.credits.toLocaleString()}</p>
      <p className="buy-credits-card__label">credits</p>
      <p className="buy-credits-card__price">{formatMinor(pkg.amountMinor, pkg.currency)}</p>
      <Button type="button" variant={recommended ? "primary" : "secondary"} loading={selecting} onClick={onSelect}>
        Buy credits
      </Button>
    </Card>
  );
}

export function BuyCreditsPage() {
  const api = useApi();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { organization, user } = useCurrentUser();
  const [error, setError] = useState<string | null>(null);
  const [successCredits, setSuccessCredits] = useState<number | null>(null);
  const [pendingCredits, setPendingCredits] = useState<number | null>(null);

  const packagesQuery = useQuery({ queryKey: ["billing", "credit-packages"], queryFn: () => api.creditPackages() });

  const checkoutMutation = useMutation({
    mutationFn: async (credits: number) => {
      setError(null);
      setPendingCredits(credits);
      const order = await api.createCreditPurchaseOrder(credits);
      const checkout = await loadRazorpayCheckout();
      return new Promise<void>((resolve, reject) => {
        checkout.open({
          key: order.razorpayKeyId,
          order_id: order.gatewayOrderId ?? "",
          amount: order.amountMinor,
          currency: order.currency,
          name: "Krevia.ai",
          description: `${order.credits.toLocaleString()} AI credits`,
          prefill: {
            name: [user?.firstName, user?.lastName].filter(Boolean).join(" "),
            ...(user?.email ? { email: user.email } : {})
          },
          notes: { organization: organization?.name ?? "" },
          handler: (response) => {
            api
              .verifyCreditPurchaseOrder(order.id, {
                razorpayOrderId: response.razorpay_order_id,
                razorpayPaymentId: response.razorpay_payment_id,
                razorpaySignature: response.razorpay_signature
              })
              .then(() => {
                setSuccessCredits(order.credits);
                void queryClient.invalidateQueries({ queryKey: ["billing"] });
                void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
                resolve();
              })
              .catch((verifyError: unknown) => {
                reject(verifyError instanceof Error ? verifyError : new Error("Payment verification failed"));
              });
          },
          modal: {
            ondismiss: () => resolve()
          }
        });
      });
    },
    onError: (mutationError: unknown) => {
      const code = (mutationError as { code?: string } | null)?.code;
      if (code === "PAYMENT_GATEWAY_NOT_CONFIGURED") {
        setError("Payments aren't set up for this workspace yet. Please contact support to enable credit top-ups.");
      } else {
        setError(mutationError instanceof Error ? mutationError.message : "Something went wrong starting checkout.");
      }
    },
    onSettled: () => setPendingCredits(null)
  });

  const onSelect = useCallback((credits: number) => checkoutMutation.mutate(credits), [checkoutMutation]);

  return (
    <AccessGate permission="billing.manage">
      <section className="usage-v2">
        <PageHeader
          title="Buy Credits"
          description="Top up your organisation's AI-credit balance. Payments are processed securely by Razorpay in your local currency."
          backHref="/usage"
          backLabel="Back to Usage"
        />

        {successCredits !== null ? (
          <Alert tone="success" title="Credits added">
            <span className="flex items-center gap-2">
              <CheckCircle2 size={16} /> {successCredits.toLocaleString()} credits have been added to your workspace.
            </span>
            <Button type="button" variant="secondary" className="buy-credits-success__cta" onClick={() => router.push("/usage")}>
              Back to Usage
            </Button>
          </Alert>
        ) : null}

        {error ? <Alert tone="danger" title="Couldn't start checkout">{error}</Alert> : null}

        {packagesQuery.isLoading ? (
          <div className="buy-credits-grid">
            {[0, 1, 2, 3].map((i) => (
              <Card key={i} className="buy-credits-card"><Skeleton /></Card>
            ))}
          </div>
        ) : packagesQuery.data ? (
          <div className="buy-credits-grid">
            {packagesQuery.data.packages.map((pkg, index) => (
              <PackageCard
                key={pkg.credits}
                pkg={pkg}
                recommended={index === 1}
                onSelect={() => onSelect(pkg.credits)}
                selecting={checkoutMutation.isPending && pendingCredits === pkg.credits}
              />
            ))}
          </div>
        ) : (
          <Alert tone="danger" title="Couldn't load credit packages">Please try again in a moment.</Alert>
        )}
      </section>
    </AccessGate>
  );
}
