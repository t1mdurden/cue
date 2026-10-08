export class RpcError extends Error {
  constructor({ code = "INTERNAL_SERVER_ERROR", status = 500, message, data }) {
    super(message || code);
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

export function validationError(fieldErrors) {
  return new RpcError({
    code: "INPUT_VALIDATION_FAILED",
    status: 422,
    message: Object.values(fieldErrors).flat().join("; ") || "Invalid input",
    data: { formErrors: [], fieldErrors },
  });
}
