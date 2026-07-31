"use client";

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth/auth-provider";
import { createBillingApi } from "./billing-api";
import { AccessGate } from "../admin/authorization";
import { Skeleton } from "../../components/ui";
import { PaymentSettingsForm } from "./payment-settings-form";

export function PaymentSettingsPage() {
  const { client } = useAuth();
  const api = useMemo(() => createBillingApi(client), [client]);
  const queryClient = useQueryClient();

  const query = useQuery({ queryKey: ["billing", "payment-settings"], queryFn: () => api.paymentSettings() });
  const save = useMutation({
    mutationFn: (body: Parameters<typeof api.updatePaymentSettings>[0]) => api.updatePaymentSettings(body),
    onSuccess: (data) => {
      queryClient.setQueryData(["billing", "payment-settings"], data);
    }
  });

  return (
    <AccessGate permission="billing.payment_settings.manage">
      <section className="admin-page">
        <header className="admin-page__header">
          <div>
            <p className="admin-eyebrow">Administration</p>
            <h1>Payment Settings</h1>
            <p>
              Connect the payment gateway your organisation uses to sell AI-credit top-ups. Only the
              organisation Owner can view or change this.
            </p>
          </div>
        </header>
        {query.isLoading ? (
          <Skeleton />
        ) : (
          <PaymentSettingsForm
            settings={query.data}
            saving={save.isPending}
            save={(body) => save.mutate(body)}
            saveError={save.isError ? save.error : null}
            saveSucceeded={save.isSuccess}
          />
        )}
      </section>
    </AccessGate>
  );
}
