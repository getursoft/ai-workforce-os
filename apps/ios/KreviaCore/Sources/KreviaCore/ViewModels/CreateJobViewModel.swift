import Foundation

@MainActor
public final class CreateJobViewModel: ObservableObject {
    @Published public var title = ""
    @Published public var description = ""
    @Published public var department = ""
    @Published public var location = ""
    @Published public var minExperienceYears = "0"
    @Published public var maxExperienceYears = ""
    @Published public var mandatorySkills = ""
    @Published public var preferredSkills = ""
    @Published public var certifications = ""
    @Published public var hiringManager = ""
    @Published public var numberOfOpenings = "1"

    @Published public private(set) var isParsingDescription = false
    @Published public var parseError: String?
    @Published public private(set) var isCreating = false
    @Published public var createError: String?
    @Published public private(set) var createdJob: RecruitmentJob?

    private let service: RecruitmentService

    public init(service: RecruitmentService) {
        self.service = service
    }

    public var canCreate: Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !mandatorySkills.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !isCreating
    }

    public func suggestCriteria() async {
        let trimmed = description.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        isParsingDescription = true
        parseError = nil
        do {
            let suggestion = try await service.parseJobDescription(trimmed)
            if !suggestion.mandatorySkills.isEmpty { mandatorySkills = suggestion.mandatorySkills.joined(separator: ", ") }
            if let preferred = suggestion.preferredSkills, !preferred.isEmpty { preferredSkills = preferred.joined(separator: ", ") }
            if let certs = suggestion.certifications, !certs.isEmpty { certifications = certs.joined(separator: ", ") }
        } catch let error as APIError {
            parseError = error.userMessage
        } catch {
            parseError = "Couldn't suggest criteria. Please try again."
        }
        isParsingDescription = false
    }

    public func create() async {
        isCreating = true
        createError = nil
        do {
            createdJob = try await service.createJob(
                title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                description: description.trimmingCharacters(in: .whitespacesAndNewlines),
                department: department.isEmpty ? nil : department,
                location: location.isEmpty ? nil : location,
                minExperienceYears: Int(minExperienceYears),
                maxExperienceYears: maxExperienceYears.isEmpty ? nil : Int(maxExperienceYears),
                requiredCriteria: RecruitmentRequiredCriteria(
                    mandatorySkills: splitList(mandatorySkills),
                    preferredSkills: splitList(preferredSkills),
                    certifications: splitList(certifications)
                ),
                hiringManager: hiringManager.isEmpty ? nil : hiringManager,
                numberOfOpenings: Int(numberOfOpenings) ?? 1
            )
        } catch let error as APIError {
            createError = error.userMessage
        } catch {
            createError = "Couldn't create this job. Please try again."
        }
        isCreating = false
    }
}

private func splitList(_ value: String) -> [String] {
    value.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
}
