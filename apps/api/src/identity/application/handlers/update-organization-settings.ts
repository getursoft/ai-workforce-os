import {
  publicOrganizationSetting,
  type OrganizationSettingsResult
} from "../models/organization-result";
import { identityError } from "../errors/identity.error";
import type { AuthenticatedPrincipal } from "../ports/authenticated-principal";
import type { IdentifierGenerator } from "../ports/identifier-generator";
import type { IdentityUnitOfWork } from "../ports/identity-unit-of-work";
import type { OrganizationRepository } from "../ports/organization-repository";
import type { OrganizationSettingRepository } from "../ports/organization-setting-repository";
import type { UserRepository } from "../ports/user-repository";
import { OrganizationSetting } from "../../domain/organization/organization-setting";
import { OrganizationSettingId } from "../../domain/organization/organization-setting-id";
import { InvalidDomainValueError } from "../../domain/shared/domain.error";
import { OrganizationAccessService } from "../services/organization-access";
import type { PlatformOwnerService } from "../../infrastructure/security/platform-owner.service";
import { assertOrganizationSettingsUpdate } from "../services/organization-update-policy";

export interface UpdateOrganizationSettingsCommand {
  timezone?: string;
  currency?: string;
  locale?: string;
}

export const UPDATE_ORGANIZATION_SETTINGS = Symbol("UpdateOrganizationSettings");

export class UpdateOrganizationSettingsHandler {
  private readonly organizationAccess: OrganizationAccessService;

  constructor(
    users: UserRepository,
    organizations: OrganizationRepository,
    private readonly organizationSettings: OrganizationSettingRepository,
    private readonly unitOfWork: IdentityUnitOfWork,
    private readonly identifiers: IdentifierGenerator,
    platformOwner: PlatformOwnerService
  ) {
    this.organizationAccess = new OrganizationAccessService(users, organizations, platformOwner);
  }

  async execute(
    principal: AuthenticatedPrincipal,
    command: UpdateOrganizationSettingsCommand
  ): Promise<OrganizationSettingsResult> {
    assertOrganizationSettingsUpdate(command);
    const { organization } = await this.organizationAccess.resolve(principal);
    const existing = await this.organizationSettings.findByOrganizationId(organization.id);
    const setting =
      existing ??
      OrganizationSetting.create({
        id: OrganizationSettingId.from(this.identifiers.generate()),
        organizationId: organization.id
      });
    const update: Parameters<OrganizationSetting["update"]>[0] = {};
    if (command.timezone !== undefined) {
      update.timezone = command.timezone;
    }
    if (command.currency !== undefined) {
      update.currency = command.currency;
    }
    if (command.locale !== undefined) {
      update.locale = command.locale;
    }
    try {
      setting.update(update);
    } catch (error: unknown) {
      if (error instanceof InvalidDomainValueError) {
        throw identityError.validation([error.message]);
      }
      throw error;
    }
    await this.unitOfWork.execute(async (repositories) => {
      await repositories.organizationSettings.save(setting);
    });
    return { organizationSetting: publicOrganizationSetting(setting) };
  }
}
