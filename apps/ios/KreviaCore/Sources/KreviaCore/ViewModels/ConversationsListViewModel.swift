import Foundation

@MainActor
public final class ConversationsListViewModel: ObservableObject {
    @Published public private(set) var interactions: [InteractionSummary] = []
    @Published public private(set) var isLoading = false
    @Published public private(set) var isLoadingMore = false
    @Published public var errorMessage: String?
    @Published public var statusFilter: InteractionStatus?

    private let conversationService: ConversationService
    private var page = 1
    private var totalPages = 1

    public init(conversationService: ConversationService) {
        self.conversationService = conversationService
    }

    public var isEmpty: Bool { interactions.isEmpty && !isLoading && errorMessage == nil }
    public var hasMore: Bool { page < totalPages }

    public func load() async {
        isLoading = true
        errorMessage = nil
        page = 1
        do {
            let result = try await conversationService.list(page: page, status: statusFilter)
            interactions = result.items
            totalPages = result.totalPages
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

    public func loadMoreIfNeeded(current item: InteractionSummary) async {
        guard item.id == interactions.last?.id, hasMore, !isLoadingMore else { return }
        isLoadingMore = true
        do {
            let result = try await conversationService.list(page: page + 1, status: statusFilter)
            interactions.append(contentsOf: result.items)
            page = result.page
            totalPages = result.totalPages
        } catch {
            // Silent — the list the user already sees stays intact; pull-to-refresh can retry.
        }
        isLoadingMore = false
    }
}
