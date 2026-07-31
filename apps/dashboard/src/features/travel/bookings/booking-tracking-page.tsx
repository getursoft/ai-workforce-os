"use client";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../auth/auth-provider";
import { createBookingApi, type TravelBooking, type BookingTimelineEntry } from "./booking-api";
import {
  Alert, Badge, Button, Card, EmptyState, PageHeader, Skeleton,
} from "../../../components/ui";

function useApi() {
  const { client, state } = useAuth();
  const orgId = state.organization?.id ?? "";
  return useMemo(() => createBookingApi(client, orgId), [client, orgId]);
}

function StatusBadge({ status }: { status: string }) {
  const tones: Record<string, "success" | "warning" | "danger" | "neutral"> = {
    DRAFT: "neutral",
    OPTIONS_PREPARED: "neutral",
    WAITING_FOR_CUSTOMER_APPROVAL: "warning",
    CUSTOMER_APPROVED: "success",
    BOOKING_REQUEST_GENERATED: "warning",
    BOOKING_IN_PROGRESS: "warning",
    BOOKED: "success",
    TICKETS_DELIVERED: "success",
    CUSTOMER_REJECTED: "danger",
    CUSTOMER_REQUESTED_CHANGES: "neutral",
    BOOKING_FAILED: "danger",
  };
  return <Badge tone={tones[status] ?? "neutral"}>{status.replace(/_/g, " ")}</Badge>;
}

export function BookingTrackingPage() {
  const api = useApi();
  const qc = useQueryClient();
  const [selectedBooking, setSelectedBooking] = useState<TravelBooking | null>(null);
  const [activeTab, setActiveTab] = useState("ALL");

  const q = useQuery({
    queryKey: ["travel-bookings", activeTab],
    queryFn: () => api.list(activeTab === "ALL" ? undefined : { status: activeTab }),
  });

  const timelineQ = useQuery({
    queryKey: ["booking-timeline", selectedBooking?.id],
    queryFn: () => (selectedBooking ? api.timeline(selectedBooking.id) : Promise.resolve([])),
    enabled: Boolean(selectedBooking),
  });

  const submitMutation = useMutation({
    mutationFn: (id: string) => api.submitToProvider(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["travel-bookings"] });
    },
  });

  const downloadMutation = useMutation({
    mutationFn: (id: string) => api.downloadTicket(id),
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
  });

  const tabs = ["ALL", "WAITING_FOR_CUSTOMER_APPROVAL", "BOOKED", "BOOKING_FAILED"];

  return (
    <section className="admin-page">
      <PageHeader
        title="Travel Bookings"
        description="Track and manage travel bookings from booking request to ticket delivery."
        backHref="/travel-employee"
        backLabel="Back to Travel Employee"
      />
      <Card className="admin-toolbar" style={{ padding: "6px" }}>
        <div className="admin-tabs">
          {tabs.map((tab) => (
            <button
              key={tab}
              className={`admin-tab ${activeTab === tab ? "admin-tab--active" : ""}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab === "ALL" ? "All" : tab.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
            </button>
          ))}
        </div>
      </Card>

      <div className="admin-grid" style={{ gridTemplateColumns: selectedBooking ? "1fr 1fr" : "1fr" }}>
        <div>
          {q.isLoading ? (
            <Skeleton />
          ) : q.isError ? (
            <Alert tone="danger" title="Unable to load bookings" />
          ) : !q.data?.items.length ? (
            <EmptyState title="No bookings" description="Bookings will appear here once customers approve their travel plans." />
          ) : (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Destination</th>
                    <th>Status</th>
                    <th>Customer</th>
                    <th>Amount</th>
                    <th>Reference</th>
                    <th>Created</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {q.data.items.map((booking) => (
                    <tr key={booking.id}>
                      <td><strong>{booking.destinationCity ?? "—"}</strong></td>
                      <td><StatusBadge status={booking.status} /></td>
                      <td>{booking.customerEmail ?? booking.customerPhone ?? "—"}</td>
                      <td>{booking.quotedAmount ? `${booking.quotedAmount} ${booking.quotedCurrency ?? ""}` : "—"}</td>
                      <td>{booking.providerBookingRef ?? "—"}</td>
                      <td>{new Date(booking.createdAt).toLocaleDateString()}</td>
                      <td>
                        <Button
                          variant="ghost"
                          onClick={() => setSelectedBooking(selectedBooking?.id === booking.id ? null : booking)}
                        >
                          {selectedBooking?.id === booking.id ? "Close" : "Details"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {selectedBooking ? (
          <div>
            <Card>
              <div className="admin-section-header">
                <h2>Booking Details</h2>
                <StatusBadge status={selectedBooking.status} />
              </div>
              <div className="admin-details">
                <dt>Reference</dt>
                <dd>{selectedBooking.providerBookingRef ?? "—"}</dd>
                <dt>PNR</dt>
                <dd>{selectedBooking.providerPnr ?? "—"}</dd>
                <dt>Route</dt>
                <dd>{selectedBooking.originCity ?? "—"} → {selectedBooking.destinationCity ?? "—"}</dd>
                <dt>Dates</dt>
                <dd>{selectedBooking.travelDates ?? "—"}</dd>
                <dt>Passengers</dt>
                <dd>{selectedBooking.passengers ?? "—"}</dd>
                <dt>Cabin</dt>
                <dd>{selectedBooking.cabinClass ?? "—"}</dd>
                <dt>Amount</dt>
                <dd>{selectedBooking.quotedAmount ? `${selectedBooking.quotedAmount} ${selectedBooking.quotedCurrency ?? ""}` : "—"}</dd>
                <dt>Email Status</dt>
                <dd><Badge tone={selectedBooking.emailDeliveryStatus === "DELIVERED" ? "success" : "warning"}>{selectedBooking.emailDeliveryStatus ?? "PENDING"}</Badge></dd>
                <dt>WhatsApp Status</dt>
                <dd><Badge tone={selectedBooking.mobileDeliveryStatus === "DELIVERED" ? "success" : "warning"}>{selectedBooking.mobileDeliveryStatus ?? "PENDING"}</Badge></dd>
                <dt>Provider Status</dt>
                <dd>{selectedBooking.providerStatus ?? "—"}</dd>
              </div>
              {selectedBooking.ticketNumbersJson?.length ? (
                <div style={{ marginTop: 12 }}>
                  <strong>Ticket Numbers:</strong>
                  <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
                    {(Array.isArray(selectedBooking.ticketNumbersJson) ? selectedBooking.ticketNumbersJson : []).map((t: string, i: number) => (
                      <li key={i}>{t}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {selectedBooking.status === "CUSTOMER_APPROVED" ? (
                <Button
                  style={{ marginTop: 16 }}
                  loading={submitMutation.isPending}
                  onClick={() => submitMutation.mutate(selectedBooking.id)}
                >
                  Submit to Provider
                </Button>
              ) : null}
              {selectedBooking.providerBookingRef ? (
                <Button
                  variant="ghost"
                  style={{ marginTop: 8 }}
                  loading={downloadMutation.isPending}
                  onClick={() => downloadMutation.mutate(selectedBooking.id)}
                >
                  Download Ticket PDF
                </Button>
              ) : null}
            </Card>

            <Card style={{ marginTop: 16 }}>
              <h2>Timeline</h2>
              {timelineQ.isLoading ? (
                <Skeleton />
              ) : timelineQ.data?.length ? (
                <div style={{ display: "grid", gap: 12 }}>
                  {timelineQ.data.map((entry: BookingTimelineEntry, i: number) => (
                    <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                      <div style={{
                        width: 12, height: 12, borderRadius: "50%",
                        background: entry.status === "BOOKED" || entry.status === "TICKETS_DELIVERED"
                          ? "var(--success, #22c55e)" : "var(--primary)",
                        flexShrink: 0, marginTop: 4,
                      }} />
                      <div>
                        <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>
                          {entry.status.replace(/_/g, " ")}
                        </div>
                        <div style={{ color: "var(--muted)", fontSize: "0.82rem" }}>
                          {new Date(entry.timestamp).toLocaleString()}
                          {entry.detail ? ` — ${entry.detail}` : ""}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ color: "var(--muted)" }}>No timeline events recorded.</p>
              )}
            </Card>
          </div>
        ) : null}
      </div>
    </section>
  );
}
