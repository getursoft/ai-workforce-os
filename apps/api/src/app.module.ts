import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";

import { IdentityModule } from "./identity/identity.module";
import { TeamModule } from "./teams/team.module";
import { ServiceAccountModule } from "./service-accounts/service-account.module";
import { PluginModule } from "./plugins/plugin.module";
import { AgentModule } from "./agents/agent.module";
import { ConnectorModule } from "./connectors/connector.module";
import { ProductionModule } from "./production/production.module";
import { KnowledgeModule } from "./knowledge/knowledge.module";
import { ChannelModule } from "./channels/channel.module";
import { TravelModule } from "./travel/travel.module";
import { HrModule } from "./hr/hr.module";
import { FinanceModule } from "./finance/finance.module";
import { ItSupportModule } from "./it-support/it-support.module";
import { SalesModule } from "./sales/sales.module";
import { MarketingModule } from "./marketing/marketing.module";
import { LegalModule } from "./legal/legal.module";
import { CustomerSupportModule } from "./customer-support/customer-support.module";
import { EmployeesModule } from "./employees/employees.module";
import { AttachmentsModule } from "./attachments/attachment.module";
import { ApprovalModule } from "./approval/approval.module";
import { BillingModule } from "./billing/billing.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { MemoryModule } from "./memory/memory.module";
import { WorkforceModule } from "./workforce/workforce.module";
import { WorkforceEventsModule } from "./workforce/workforce-event-bus";
import { ObservabilityCoreModule } from "./observability/observability-core.module";
import { ObservabilityModule } from "./observability/observability.module";
import { SchedulerModule } from "./scheduler/scheduler.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    NotificationsModule,
    ObservabilityCoreModule,
    IdentityModule,
    TeamModule,
    ServiceAccountModule,
    PluginModule,
    ConnectorModule,
    AgentModule,
    KnowledgeModule,
    ChannelModule,
    TravelModule,
    ApprovalModule,
    HrModule,
    FinanceModule,
    ItSupportModule,
    SalesModule,
    MarketingModule,
    LegalModule,
    CustomerSupportModule,
    EmployeesModule,
    AttachmentsModule,
    BillingModule,
    ProductionModule,
    MemoryModule,
    WorkforceEventsModule,
    WorkforceModule,
    ObservabilityModule,
    SchedulerModule,
  ],
})
export class AppModule {}