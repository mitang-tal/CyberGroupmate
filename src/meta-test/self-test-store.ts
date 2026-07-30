import { MetaSelfTestReport, ProbeCategory } from "./types";

export interface SelfTestStore {
    insertReport(report: MetaSelfTestReport): void;
    getLatestReport(): MetaSelfTestReport | undefined;
    queryHistory(limit?: number): MetaSelfTestReport[];
}
