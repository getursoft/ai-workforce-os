import "reflect-metadata";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { describe, expect, it } from "vitest";
import { PERMISSION_METADATA, type PermissionRequirement } from "../../identity/presentation/http/permission.decorators";
import { JwtAccessGuard } from "../../identity/presentation/http/jwt-access.guard";
import { PermissionGuard } from "../../identity/presentation/http/permission.guard";
import { TravelBookingController } from "./travel-booking.controller";

function permissionFor(method: keyof TravelBookingController): PermissionRequirement | undefined {
  return Reflect.getMetadata(PERMISSION_METADATA, TravelBookingController.prototype[method] as object);
}

describe("TravelBookingController RBAC/tenant-scoping wiring", () => {
  // Regression: this controller previously had zero @UseGuards/@RequirePermission at all and trusted a
  // client-supplied `?organizationId=` query param for tenant scoping — any authenticated (or even
  // unauthenticated) caller could read or act on another organization's bookings by guessing/changing
  // that param. Every route must now require the standard JwtAccessGuard + PermissionGuard pair and
  // derive the organization strictly from the verified JWT principal.
  it("applies JwtAccessGuard and PermissionGuard at the controller level", () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, TravelBookingController) as unknown[];
    expect(guards).toContain(JwtAccessGuard);
    expect(guards).toContain(PermissionGuard);
  });

  it("requires travel.booking.read for reading bookings, timelines, and tickets", () => {
    expect(permissionFor("listBookings")).toEqual({ mode: "all", permissions: ["travel.booking.read"] });
    expect(permissionFor("getBooking")).toEqual({ mode: "all", permissions: ["travel.booking.read"] });
    expect(permissionFor("getTimeline")).toEqual({ mode: "all", permissions: ["travel.booking.read"] });
    expect(permissionFor("downloadTicket")).toEqual({ mode: "all", permissions: ["travel.booking.read"] });
  });

  it("requires travel.booking.approve.customer for requesting customer approval", () => {
    expect(permissionFor("requestCustomerApproval")).toEqual({
      mode: "all",
      permissions: ["travel.booking.approve.customer"]
    });
  });

  it("requires travel.booking.manage for recording decisions, provider submission, and ticket delivery", () => {
    expect(permissionFor("customerApprove")).toEqual({ mode: "all", permissions: ["travel.booking.manage"] });
    expect(permissionFor("customerReject")).toEqual({ mode: "all", permissions: ["travel.booking.manage"] });
    expect(permissionFor("submitToProvider")).toEqual({ mode: "all", permissions: ["travel.booking.manage"] });
    expect(permissionFor("deliverTickets")).toEqual({ mode: "all", permissions: ["travel.booking.manage"] });
  });

  it("requires the existing travel.cancellation.* permissions for cancellation routes", () => {
    expect(permissionFor("requestCancellation")).toEqual({
      mode: "all",
      permissions: ["travel.cancellation.request"]
    });
    expect(permissionFor("approveCancellation")).toEqual({
      mode: "all",
      permissions: ["travel.cancellation.approve"]
    });
    expect(permissionFor("rejectCancellation")).toEqual({
      mode: "all",
      permissions: ["travel.cancellation.approve"]
    });
  });
});
