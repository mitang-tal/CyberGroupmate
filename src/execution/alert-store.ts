import { ExecutionAlert, CreateAlertPayload, AlertStatus, AlertRuleType, AlertSeverity } from "./execution-record.types";

export interface AlertStore {
    insertOrUpdate(payload: CreateAlertPayload, cooldownMs?: number): ExecutionAlert;
    getById(alertId: string): ExecutionAlert | undefined;
    query(options: {
        status?: AlertStatus;
        severity?: AlertSeverity;
        ruleType?: AlertRuleType;
        sourceComponent?: string;
        limit?: number;
        offset?: number;
    }): ExecutionAlert[];
    updateStatus(alertId: string, status: AlertStatus): void;
    getActiveAlertCount(): number;
}
