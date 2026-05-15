type LogMessage = string | (() => string);

export interface Logger {
    debug: (messageOrLambda: LogMessage, namespace: string) => void;
    info: (messageOrLambda: LogMessage, namespace: string) => void;
    warning: (messageOrLambda: LogMessage, namespace: string) => void;
    error: (messageOrLambda: LogMessage, namespace: string) => void;
}

function stringifyLogError(error: unknown): string {
    try {
        return String(error);
    } catch {
        return "<unprintable error>";
    }
}

function formatLogMessage(messageOrLambda: LogMessage): string {
    try {
        return typeof messageOrLambda === "function" ? messageOrLambda() : messageOrLambda;
    } catch (error) {
        return `Log message formatting failed: ${stringifyLogError(error)}`;
    }
}

export let logger: Logger = {
    debug: (messageOrLambda, namespace) => console.debug(`[${new Date().toISOString()}] ${namespace}: ${formatLogMessage(messageOrLambda)}`),
    info: (messageOrLambda, namespace) => console.info(`[${new Date().toISOString()}] ${namespace}: ${formatLogMessage(messageOrLambda)}`),
    warning: (messageOrLambda, namespace) => console.warn(`[${new Date().toISOString()}] ${namespace}: ${formatLogMessage(messageOrLambda)}`),
    error: (messageOrLambda, namespace) => console.error(`[${new Date().toISOString()}] ${namespace}: ${formatLogMessage(messageOrLambda)}`),
};

export function setLogger(l: Logger): void {
    logger = l;
}
