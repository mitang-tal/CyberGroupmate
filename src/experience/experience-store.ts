import { FailurePattern, ExperienceItem, ExperienceQuery, ExperienceStatus, FailureCategory } from "./types";

export interface ExperienceStore {
    // Patterns
    insertPattern(pattern: FailurePattern): void;
    updatePattern(patternId: string, updates: Partial<FailurePattern>): void;
    getPattern(patternId: string): FailurePattern | undefined;
    queryPatterns(category?: FailureCategory, minConfidence?: number): FailurePattern[];
    findExistingPattern(triggerContext: string, symptom: string): FailurePattern | undefined;

    // Experiences
    insertExperience(item: ExperienceItem): void;
    updateExperience(experienceId: string, updates: Partial<ExperienceItem>): void;
    getExperience(experienceId: string): ExperienceItem | undefined;
    queryExperiences(query: ExperienceQuery): ExperienceItem[];
    listExpiredExperiences(): ExperienceItem[];
    decayExperiences(): number; // returns count of decayed items
}
