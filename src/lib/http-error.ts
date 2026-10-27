export class HttpError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string,
        message: string,
        public readonly details?: unknown,
    ) {
        super(message);
        this.name = "HttpError";
    }

    static badRequest(message: string, details?: unknown): HttpError {
        return new HttpError(400, "BAD_REQUEST", message, details);
    }

    static unauthorized(message = "Authentication required"): HttpError {
        return new HttpError(401, "UNAUTHORIZED", message);
    }

    static forbidden(message = "Forbidden"): HttpError {
        return new HttpError(403, "FORBIDDEN", message);
    }

    static notFound(message = "Not found"): HttpError {
        return new HttpError(404, "NOT_FOUND", message);
    }

    static conflict(code: string, message: string): HttpError {
        return new HttpError(409, code, message);
    }
}
