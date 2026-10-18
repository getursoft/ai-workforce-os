import { Module } from "@nestjs/common";
import { PrismaModule } from "../../infrastructure/prisma/prisma.module";
import { IdentityModule } from "../../identity/identity.module";
import { PluginModule } from "../../plugins/plugin.module";
import { RecruitmentModule } from "../recruitment.module";
import { RecruitmentWhatsAppController } from "./recruitment-whatsapp.controller";
import { RecruitmentWhatsAppLinkService } from "./recruitment-whatsapp-link.service";
import { RecruitmentWhatsAppMenuService } from "./recruitment-whatsapp-menu.service";
import { RecruitmentWhatsAppSenderService } from "./recruitment-whatsapp-sender.service";

/** Sprint 7.16 — a separate module from RecruitmentModule (which stays website/API-focused) so the
 * WhatsApp surface's dependencies (IdentityModule's AuthorizationService, PluginModule's AI resolution)
 * are scoped to where they're actually needed, while reusing RecruitmentModule's exported query/export/
 * job/resume services rather than re-implementing or duplicating any of them. */
@Module({
  imports: [PrismaModule, IdentityModule, PluginModule, RecruitmentModule],
  controllers: [RecruitmentWhatsAppController],
  providers: [RecruitmentWhatsAppLinkService, RecruitmentWhatsAppMenuService, RecruitmentWhatsAppSenderService]
})
export class RecruitmentWhatsAppModule {}
