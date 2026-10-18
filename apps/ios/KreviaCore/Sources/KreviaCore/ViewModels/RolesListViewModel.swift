import Foundation

@MainActor
public final class RolesListViewModel: ObservableObject {
    @Published public private(set) var roles: [OrgRole] = []
    @Published public private(set) var isLoading = false
    @Published public var errorMessage: String?
    @Published public private(set) var isCreating = false
    @Published public var createError: String?

    private let roleService: RoleService

    public init(roleService: RoleService) {
        self.roleService = roleService
    }

    public var isEmpty: Bool { roles.isEmpty && !isLoading && errorMessage == nil }

    public func load() async {
        isLoading = true
        errorMessage = nil
        do {
            roles = try await roleService.list()
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = "Something went wrong. Please try again."
        }
        isLoading = false
    }

    public func refresh() async {
        await load()
    }

    @discardableResult
    public func createRole(name: String, description: String?) async -> Bool {
        isCreating = true
        createError = nil
        do {
            let role = try await roleService.create(name: name, description: description)
            roles.append(role)
            roles.sort { $0.name < $1.name }
            isCreating = false
            return true
        } catch let error as APIError {
            createError = error.userMessage
        } catch {
            createError = "Couldn't create this role. Please try again."
        }
        isCreating = false
        return false
    }
}
