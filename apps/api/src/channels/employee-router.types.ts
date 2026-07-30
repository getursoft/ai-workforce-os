export type RoutingStatus = "AWAITING_INTENT" | "ROUTED" | "AMBIGUOUS" | "OUT_OF_SCOPE" | "NO_EMPLOYEE_AVAILABLE";

export interface EmployeeRoutingDecision {
  status: RoutingStatus;
  employeeInstallationId?: string;
  confidence: number;
  detectedIntent?: string;
  reasonCode: string;
  candidateEmployeeIds?: string[];
}

export interface ConversationRoutingState {
  routingStatus: RoutingStatus;
  selectedEmployeeId: string | null;
  detectedIntent: string | null;
  routingConfidence: number;
  routedAt: string | null;
  lastRoutedAt: string | null;
  clarificationCount: number;
}

export const DEFAULT_RECEPTIONIST_GREETING = "Hello! Good Morning! Thank you for contacting us, How can we help you today?";
export const DEFAULT_INTENT_QUESTION = "May I know the reason for contacting us?";
export const DEFAULT_OUT_OF_SCOPE_MESSAGE = "This request is outside the scope of the AI Employees currently available for this organisation.";
export const DEFAULT_AMBIGUOUS_MESSAGE = "Could you please provide more details so I can connect you to the right team?";
export const DEFAULT_ACKNOWLEDGEMENT_MESSAGE = "Thank you for reaching out. I'll be happy to help with that. Please allow me a moment while I check the relevant information.";
export const DEFAULT_FAILURE_MESSAGE = "Sorry, I wasn't able to complete that request right now. Please try again in a moment.";
export const MAX_CLARIFICATION_ATTEMPTS = 2;

export const SUBJECT_CHANGE_PATTERNS = [
  /\b(?:now|also)\b.{0,30}\b(?:hr|human\s*resource|policy|leave|maternity|payroll|benefit|hiring)\b/i,
  /\b(?:now|also)\b.{0,30}\b(?:it|vpn|computer|laptop|network|password|software|tech|support)\b/i,
  /\b(?:now|also)\b.{0,30}\b(?:travel|trip|flight|hotel|booking|holiday|vacation)\b/i,
  /\b(?:now|also)\b.{0,30}\b(?:sales|purchase|product|pricing|quote|order|invoice)\b/i,
  /\bchange\s+(?:the\s+)?topic\b/i,
  /\bswitch\s+(?:to|the)\b/i,
  /\bdifferent\s+(?:question|request|topic|department)\b/i,
  /\bconnect\s+me\s+to\b/i
];

export const GREETING_PATTERNS = [
  /\b(hi|hello|hey|namaste|good\s*(morning|afternoon|evening|day))\b/i
];
