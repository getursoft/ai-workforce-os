export interface CaseStudy {
  slug: string;
  title: string;
  sector: string;
  summary: string;
  challenge: string;
  solution: string;
  outcome: string[];
}

export const caseStudies: CaseStudy[] = [
  {
    slug: "travel-desk-response-times",
    title: "Cutting Travel Desk Response Times",
    sector: "Travel and Hospitality",
    summary: "A representative scenario showing how a Travel AI Employee handles first-draft itinerary requests at volume.",
    challenge: "A travel planning company's desk was fielding dozens of itinerary requests daily, with average first response taking most of a business day.",
    solution: "A Travel AI Employee was configured to draft itineraries and budget estimates aligned with company policy, capturing traveller requirements before handing qualified requests to human consultants.",
    outcome: [
      "Faster first response on trip enquiries",
      "More consistent itinerary quality across the team",
      "Consultants spending more time on complex, high-value trips",
    ],
  },
  {
    slug: "hr-shared-services-volume",
    title: "Reducing Repetitive Volume in HR Shared Services",
    sector: "Human Resources",
    summary: "A representative scenario for a large organisation's HR shared-services function.",
    challenge: "A shared-services HR team was spending the majority of its time on repeatable policy, leave and onboarding questions.",
    solution: "An HR AI Employee was deployed to answer common questions directly, guide onboarding checklists, and escalate sensitive matters to human HR staff.",
    outcome: [
      "Reduced repetitive query volume reaching HR staff",
      "Faster onboarding completion for new employees",
      "Clearer audit trail of employee requests",
    ],
  },
  {
    slug: "it-helpdesk-triage",
    title: "Improving Triage for an Internal IT Helpdesk",
    sector: "Information Technology",
    summary: "A representative scenario for a mid-sized company's internal IT function.",
    challenge: "A small internal IT team was overwhelmed by first-line technical requests, leading to slow response on genuinely urgent incidents.",
    solution: "An IT Support AI Employee resolved common issues through guided troubleshooting and triaged incoming tickets by urgency before escalating to engineers.",
    outcome: [
      "Faster first response across the helpdesk",
      "Better-prioritised escalations reaching engineers",
      "Clearer communication to staff during known incidents",
    ],
  },
  {
    slug: "sales-lead-qualification",
    title: "Speeding Up Lead Qualification for a Sales Team",
    sector: "Sales",
    summary: "A representative scenario for a B2B software company's sales development function.",
    challenge: "Inbound lead volume was outpacing the sales development team's ability to qualify and respond quickly.",
    solution: "A Sales AI Employee qualified leads against defined criteria, prepared account briefings, and handed qualified leads to the CRM with full context.",
    outcome: [
      "Faster lead response times",
      "Reps arriving better prepared to every meeting",
      "Cleaner, more current CRM records",
    ],
  },
];

export const getCaseStudy = (slug: string) => caseStudies.find((study) => study.slug === slug);
