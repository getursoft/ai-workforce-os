import SwiftUI
import KreviaCore

/// Conversation with a single AI Employee — maps 1:1 to the dashboard's `EmployeeChatPage`
/// (`POST /agents/run`), the same path the web chat UI uses, not the `/plugins/:id/chat` dev stub.
struct EmployeeChatView: View {
    @StateObject private var viewModel: EmployeeChatViewModel
    let employeeName: String
    @FocusState private var isInputFocused: Bool

    init(employeeId: String, employeeName: String, dependencies: AppDependencies) {
        self.employeeName = employeeName
        _viewModel = StateObject(wrappedValue: EmployeeChatViewModel(employeeId: employeeId, agentService: dependencies.agentService))
    }

    var body: some View {
        VStack(spacing: 0) {
            messageList
            inputBar
        }
        .background(KreviaTheme.background)
        .navigationTitle(employeeName)
        .navigationBarTitleDisplayMode(.inline)
    }

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if viewModel.messages.isEmpty {
                        VStack(spacing: 10) {
                            Image(systemName: "message.badge.waveform.fill")
                                .font(.largeTitle)
                                .foregroundStyle(KreviaTheme.muted)
                            Text("Start a conversation with \(employeeName)")
                                .font(.subheadline)
                                .foregroundStyle(KreviaTheme.muted)
                                .multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.top, 60)
                    }
                    ForEach(viewModel.messages) { message in
                        ChatBubble(message: message).id(message.id)
                    }
                    if viewModel.isSending {
                        HStack {
                            ProgressView().tint(KreviaTheme.muted)
                            Text("Thinking…").font(.caption).foregroundStyle(KreviaTheme.muted)
                        }
                    }
                    if let error = viewModel.errorMessage {
                        Text(error).font(.caption).foregroundStyle(KreviaTheme.danger)
                    }
                    // Dedicated zero-height anchor at the true bottom of the content — scrolling to a
                    // specific message's id can land short of the fold once the "Thinking…" row or an
                    // error line renders below it; this anchor always reflects the full content height.
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding()
            }
            .onChange(of: viewModel.messages) { _ in scrollToBottom(proxy) }
            .onChange(of: viewModel.isSending) { _ in scrollToBottom(proxy) }
            .onChange(of: isInputFocused) { _ in scrollToBottom(proxy) }
        }
    }

    /// Deferred one run-loop tick: `proxy.scrollTo` called synchronously inside `.onChange` can fire
    /// before SwiftUI finishes laying out the just-appended bubble, landing short of the real bottom.
    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        DispatchQueue.main.async {
            withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
        }
    }

    private var inputBar: some View {
        HStack(spacing: 10) {
            TextField("Message \(employeeName)", text: $viewModel.draft, axis: .vertical)
                .lineLimit(1...4)
                .focused($isInputFocused)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(KreviaTheme.surface)
                .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(KreviaTheme.border, lineWidth: 1))
            Button {
                Task { await viewModel.send() }
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 32))
                    .foregroundStyle(viewModel.canSend ? KreviaTheme.primary : KreviaTheme.muted)
            }
            .disabled(!viewModel.canSend)
        }
        .padding()
        .background(KreviaTheme.background)
    }
}

private struct ChatBubble: View {
    let message: ConversationChatMessage

    private var isUser: Bool { message.role == .user }

    var body: some View {
        HStack {
            if isUser { Spacer(minLength: 40) }
            Text(message.content)
                .font(.subheadline)
                .foregroundStyle(isUser ? .white : KreviaTheme.ink)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(isUser ? KreviaTheme.primary : KreviaTheme.surface)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            if !isUser { Spacer(minLength: 40) }
        }
    }
}
