import { Module, forwardRef } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { AgentModule } from "../agents/agent.module";
import { PluginModule } from "../plugins/plugin.module";
import { TravelEmployeeController } from "./travel.controller";
import { TravelEmployeeService } from "./travel.service";
import { TravelBookingService } from "./booking/travel-booking.service";
import { TravelCancellationService } from "./cancellation/travel-cancellation.service";
import { TravelBookingController } from "./booking/travel-booking.controller";
import { BookingProviderAdapter } from "./provider/booking-provider-adapter";
import { DummyBookingAdapter } from "./provider/dummy-booking-adapter";
import { TicketGeneratorService } from "./delivery/ticket-generator.service";
import { DeliveryRecorderService } from "./delivery/delivery-recorder.service";

@Module({
  imports: [PrismaModule, IdentityModule, PluginModule, forwardRef(() => AgentModule)],
  controllers: [TravelEmployeeController, TravelBookingController],
  providers: [
    TravelEmployeeService,
    TravelBookingService,
    TravelCancellationService,
    TicketGeneratorService,
    DeliveryRecorderService,
    {
      provide: BookingProviderAdapter,
      useClass: DummyBookingAdapter,
    },
  ],
  exports: [
    TravelEmployeeService,
    TravelBookingService,
    TravelCancellationService,
    BookingProviderAdapter,
    TicketGeneratorService,
    DeliveryRecorderService,
  ],
})
export class TravelModule {}
