import {
  publicOrganizationSetting,
  type OrganizationSettingsResult
} from "../models/organization-result";
import type { AuthenticatedPrincipal } from "../ports/authenticated-principal";
import type { IdentifierGenerator } from "../ports/identifier-generator";
import type { IdentityUnitOfWork } from "../ports/identity-unit-of-work";
import type { OrganizationRepository } from "../ports/organization-repository";
import type { OrganizationSettingRepository } from "../ports/organization-setting-repository";
import type { UserRepository } from "../ports/user-repository";
import { OrganizationSetting } from "../../domain/organization/organization-setting";
import { OrganizationSettingId } from "../../domain/organization/organization-setting-id";
import { OrganizationAccessService } from "../services/organization-access";
import type { PlatformOwnerService } from "../../infrastructure/security/platform-owner.service";

export const GET_ORGANIZATION_SETTINGS = Symbol("GetOrganizationSettings");

export class GetOrganizationSettingsHandler {
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

  async execute(principal: AuthenticatedPrincipal): Promise<OrganizationSettingsResult> {
    const { organization } = await this.organizationAccess.resolve(principal);
    const existing = await this.organizationSettings.findByOrganizationId(organization.id);
    if (existing) {
      return { organizationSetting: publicOrganizationSetting(existing) };
    }
    const defaults = OrganizationSetting.create({
      id: OrganizationSettingId.from(this.identifiers.generate()),
      organizationId: organization.id
    });
    await this.unitOfWork.execute(async (repositories) => {
      await repositories.organizationSettings.save(defaults);
    });
    return { organizationSetting: publicOrganizationSetting(defaults) };
  }
}
