// Validate an error is an HTTP error of the type thrown by Octokit, i.e.:
// { status: number, response: { data: { message: string } } }
export const isHttpError = (
	error: unknown,
): error is { status: number; response: { data: { message: string } } } =>
	// Error has status code
	typeof error === 'object' &&
	error !== null &&
	'status' in error &&
	typeof error.status === 'number' &&
	'response' in error &&
	typeof error.response === 'object' &&
	error.response !== null &&
	'data' in error.response &&
	typeof error.response.data === 'object';

// Use a specific error to indicate an error is due to code conflict,
// as opposed to other endpoints which might throw 409s for other reasons.
export class CodeConflictError extends Error {
	public commitSha: string;
	constructor(message: string, commitSha: string) {
		super(message);
		this.commitSha = commitSha;
	}
}

export const isCodeConflictError = (
	error: unknown,
): error is CodeConflictError =>
	error instanceof CodeConflictError && typeof error.commitSha === 'string';

export class RemoteChangedError extends Error {}
