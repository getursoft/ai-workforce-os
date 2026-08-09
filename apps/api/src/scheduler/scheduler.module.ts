import { Module } from "@nestjs/common";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { IdentityModule } from "../identity/identity.module";
import { AgentModule } from "../agents/agent.module";
import { MemoryModule } from "../memory/memory.module";
import { SkillPlatformModule } from "../skills-platform/skill-platform.module";
import { SchedulerService } from "./scheduler.service";
import { SchedulerController } from "./scheduler.controller";
import { JobRegistry } from "./job-registry";
import { JobDispatcher } from "./job-dispatcher";
import { JobExecutor } from "./job-executor";
import { JobHistoryService } from "./job-history.service";
import { JobLockService } from "./job-lock.service";
import { JobRetryService } from "./job-retry.service";
import { SchedulerWorkerHealth } from "./scheduler-worker.health";
import { SchedulerHandlers } from "./scheduler-handlers";
import { ReminderComposer } from "./reminder-composer";
import { SchedulerDeliveryService } from "./scheduler-delivery.service";
import { SchedulerEventBridge } from "./scheduler-event-bridge";
import { SchedulerEventsModule } from "./scheduler-event-bus";

@Module({
  imports: [PrismaModule, IdentityModule, AgentModule, MemoryModule, SchedulerEventsModule, SkillPlatformModule],
  controllers: [SchedulerController],
  providers: [
    SchedulerService,
    JobRegistry,
    JobDispatcher,
    JobExecutor,
    JobHistoryService,
    JobLockService,
    JobRetryService,
    SchedulerWorkerHealth,
    SchedulerHandlers,
    ReminderComposer,
    SchedulerDeliveryService,
    SchedulerEventBridge
  ],
  exports: [SchedulerService, JobHistoryService, JobLockService, JobRegistry, SchedulerEventBridge]
})
export class SchedulerModule {}
