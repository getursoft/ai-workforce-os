import { Global, Module } from "@nestjs/common";
import { PrismaModule } from "../infrastructure/prisma/prisma.module";
import { PostgresQueueAdapter } from "./postgres-queue.adapter";
import { QueueConsumerWorker, QueueHandlerRegistry, QueueHealthService } from "./queue-worker";
import { QUEUE, QUEUE_HANDLERS } from "./queue.tokens";
import { NotificationJobHandler } from "./notification-job-handler";

@Global()
@Module({
  imports: [PrismaModule],
  providers: [
    { provide: QUEUE, useClass: PostgresQueueAdapter },
    { provide: QUEUE_HANDLERS, useClass: QueueHandlerRegistry },
    QueueHandlerRegistry,
    QueueHealthService,
    QueueConsumerWorker,
    NotificationJobHandler
  ],
  exports: [QUEUE, QUEUE_HANDLERS, QueueHandlerRegistry, QueueHealthService, QueueConsumerWorker, NotificationJobHandler]
})
export class QueueModule {}
