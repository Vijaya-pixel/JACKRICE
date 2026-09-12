import { localDb } from "@/lib/local-db";
import type {
  ClinicalContext,
  Interaction,
  KeyboardCompletionsResponse,
  Patient,
  Session,
  SuggestedQuestion,
  SuggestedQuestionsResponse,
} from "@/types/tacit";

export type SuggestedQuestionContext = {
  patient: Patient;
  session: Session;
  clinicalContext?: ClinicalContext | null;
  recentInteractions?: Interaction[];
  currentSessionInteractions?: Interaction[];
};

const FALLBACK_QUESTIONS: SuggestedQuestion[] = [
  { question: "Are you currently in pain?", type: "yes_no" },
  {
    question: "What do you need right now?",
    type: "option_board",
    boardOptions: ["Pain", "Water", "Position", "Bathroom", "Something Else", "Keyboard"],
  },
  { question: "Do you want us to reposition you?", type: "yes_no" },
];

export async function buildSuggestedQuestionContext(
  patient: Patient,
  session: Session,
): Promise<SuggestedQuestionContext> {
  const [clinicalContext, currentSessionInteractions] = await Promise.all([
    localDb.getClinicalContext(patient.id),
    localDb.listInteractionsForSession(session.id),
  ]);

  return {
    patient,
    session,
    clinicalContext,
    recentInteractions: currentSessionInteractions.slice(-8),
    currentSessionInteractions: currentSessionInteractions.slice(-8),
  };
}

export async function generateSuggestedQuestions(
  context: SuggestedQuestionContext,
): Promise<SuggestedQuestionsResponse> {
  if (!window.tacit?.getGeminiQuestionSuggestions) {
    return {
      source: "fallback",
      questions: FALLBACK_QUESTIONS,
      error: "Gemini question suggestions are only available in the Electron app.",
    };
  }

  const response = await window.tacit.getGeminiQuestionSuggestions({
    patient: context.patient,
    clinicalContext: context.clinicalContext,
    recentInteractions: context.recentInteractions ?? [],
    currentSessionInteractions: context.currentSessionInteractions ?? [],
  });

  if (!response.questions.length) {
    return {
      ...response,
      questions: FALLBACK_QUESTIONS,
    };
  }

  return response;
}

export type KeyboardCompletionContext = SuggestedQuestionContext & {
  typedText: string;
  clinicianQuestion?: string;
};

function normalizeCompletionList(completions: string[], typedText: string) {
  const prefix = typedText.replace(/\s+/g, " ").trim();
  const prefixKey = prefix.toLowerCase();
  const seen = new Set<string>();
  return completions
    .map((completion) => completion.replace(/\s+/g, " ").trim())
    .filter((completion) => {
      if (!completion || completion.length > 80) return false;
      if (prefixKey && !completion.toLowerCase().startsWith(prefixKey)) return false;
      const key = completion.toLowerCase();
      if (key === prefixKey || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3);
}

export async function generateKeyboardCompletions(
  context: KeyboardCompletionContext,
): Promise<KeyboardCompletionsResponse> {
  if (context.typedText.trim().length < 2) {
    return { source: "fallback", completions: [] };
  }

  if (!window.tacit?.getGeminiKeyboardCompletions) {
    return {
      source: "fallback",
      completions: [],
      error: "Gemini keyboard completions are only available in the Electron app.",
    };
  }

  const response = await window.tacit.getGeminiKeyboardCompletions({
    typedText: context.typedText,
    clinicianQuestion: context.clinicianQuestion,
    patient: context.patient,
    clinicalContext: context.clinicalContext,
    recentInteractions: context.recentInteractions ?? [],
    currentSessionInteractions: context.currentSessionInteractions ?? [],
  });

  return {
    ...response,
    completions: normalizeCompletionList(response.completions, context.typedText),
  };
}
