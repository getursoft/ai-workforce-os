import Foundation

@MainActor
public final class OrganizationSettingsViewModel: ObservableObject {
    @Published public private(set) var organization: OrganizationSummary?
    @Published public private(set) var settings: OrganizationSettingsDetail?
    @Published public private(set) var isLoading = false
    @Published public var errorMessage: String?
    @Published public private(set) var isSaving = false
    @Published public var saveError: String?
    @Published public var saveSucceeded = false

    private let organizationService: OrganizationService

    public init(organizationService: OrganizationService) {
        self.organizationService = organizationService
    }

    public func load() async {
        isLoading = true
        errorMessage = nil
        do {
            async let org = organizationService.me()
            async let settings = organizationService.meSettings()
            (organization, self.settings) = try await (org, settings)
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = "Something went wrong. Please try again."
        }
        isLoading = false
    }

    public func save(name: String, timezone: String, currency: String, locale: String) async {
        isSaving = true
        saveError = nil
        saveSucceeded = false
        do {
            async let org = organizationService.updateMe(name: name)
            async let settings = organizationService.updateMeSettings(timezone: timezone, currency: currency, locale: locale)
            (organization, self.settings) = try await (org, settings)
            saveSucceeded = true
        } catch let error as APIError {
            saveError = error.userMessage
        } catch {
            saveError = "Couldn't save changes. Please try again."
        }
        isSaving = false
    }
}
