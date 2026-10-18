import SwiftUI
import KreviaCore

struct LoginView: View {
    @StateObject private var viewModel: LoginViewModel
    @FocusState private var focusedField: Field?

    private enum Field { case organization, email, password }

    init(dependencies: AppDependencies) {
        _viewModel = StateObject(
            wrappedValue: LoginViewModel(authService: dependencies.authService, session: dependencies.session)
        )
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    VStack(spacing: 6) {
                        Text("Krevia")
                            .font(.largeTitle.bold())
                            .foregroundStyle(KreviaTheme.primary)
                        Text("Sign in to your workspace")
                            .font(.subheadline)
                            .foregroundStyle(KreviaTheme.muted)
                    }
                    .padding(.top, 40)
                    .accessibilityAddTraits(.isHeader)

                    VStack(spacing: 14) {
                        labeledField("Organization", text: $viewModel.organizationName, contentType: .organizationName)
                            .focused($focusedField, equals: .organization)
                        labeledField("Email", text: $viewModel.email, contentType: .emailAddress, keyboard: .emailAddress)
                            .focused($focusedField, equals: .email)
                        labeledSecureField("Password", text: $viewModel.password)
                            .focused($focusedField, equals: .password)
                    }

                    if let error = viewModel.errorMessage {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(KreviaTheme.danger)
                            .accessibilityLabel("Sign in error: \(error)")
                    }

                    Button {
                        focusedField = nil
                        Task { await viewModel.login() }
                    } label: {
                        if viewModel.isLoading {
                            ProgressView().tint(.white)
                        } else {
                            Text("Sign In").fontWeight(.semibold)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(KreviaTheme.primary)
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .disabled(!viewModel.canSubmit)
                    .accessibilityLabel("Sign in")
                }
                .padding(24)
            }
            .background(KreviaTheme.background)
            .navigationBarHidden(true)
        }
    }

    private func labeledField(
        _ title: String,
        text: Binding<String>,
        contentType: UITextContentType,
        keyboard: UIKeyboardType = .default
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(KreviaTheme.muted)
            TextField(title, text: text)
                .textFieldStyle(.plain)
                .padding(12)
                .background(KreviaTheme.surface)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .textContentType(contentType)
                .keyboardType(keyboard)
                .autocapitalization(.none)
                .disableAutocorrection(true)
                .accessibilityLabel(title)
        }
    }

    private func labeledSecureField(_ title: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(KreviaTheme.muted)
            SecureField(title, text: text)
                .padding(12)
                .background(KreviaTheme.surface)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .textContentType(.password)
                .accessibilityLabel(title)
        }
    }
}
