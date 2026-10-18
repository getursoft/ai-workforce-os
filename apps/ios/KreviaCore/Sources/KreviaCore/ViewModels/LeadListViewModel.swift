import Foundation

@MainActor
public final class LeadListViewModel: ObservableObject {
    @Published public private(set) var leads: [Lead] = []
    @Published public private(set) var isLoading: Bool = false
    @Published public private(set) var isLoadingMore: Bool = false
    @Published public var errorMessage: String?
    @Published public var searchText: String = ""
    @Published public var statusFilter: LeadStatus?
    @Published public var sourceFilter: LeadSource?

    private let leadService: LeadService
    private var page = 1
    private var totalPages = 1
    private var searchTask: Task<Void, Never>?

    public init(leadService: LeadService) {
        self.leadService = leadService
    }

    public var canLoadMore: Bool { page < totalPages && !isLoadingMore }
    public var isEmpty: Bool { leads.isEmpty && !isLoading && errorMessage == nil }

    public func loadFirstPage() async {
        page = 1
        isLoading = true
        errorMessage = nil
        await fetch(page: 1, replacing: true)
        isLoading = false
    }

    public func refresh() async {
        await loadFirstPage()
    }

    public func loadNextPageIfNeeded(currentItem lead: Lead) async {
        guard let last = leads.last, last.id == lead.id, canLoadMore else { return }
        isLoadingMore = true
        await fetch(page: page + 1, replacing: false)
        isLoadingMore = false
    }

    /// Debounced search — call on every keystroke; only the latest query actually fires.
    public func onSearchTextChanged() {
        searchTask?.cancel()
        searchTask = Task {
            try? await Task.sleep(nanoseconds: 350_000_000)
            guard !Task.isCancelled else { return }
            await loadFirstPage()
        }
    }

    public func applyFilters() async {
        await loadFirstPage()
    }

    private func fetch(page requestedPage: Int, replacing: Bool) async {
        do {
            let query = ListLeadsQuery(
                page: requestedPage,
                pageSize: 20,
                status: statusFilter,
                source: sourceFilter,
                search: searchText.isEmpty ? nil : searchText
            )
            let result = try await leadService.list(query)
            page = result.page
            totalPages = max(result.totalPages, 1)
            leads = replacing ? result.items : leads + result.items
            errorMessage = nil
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = "Something went wrong. Please try again."
        }
    }
}
