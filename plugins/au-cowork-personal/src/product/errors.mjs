// Ported from accepted backend dfe3a879; see docs/product-tools.md.
class DomainError extends Error {
  constructor(status, code, message, effect = "none", fields = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.effect = effect;
    this.fields = fields;
  }
}
function fail(status, code, message) {
  throw new DomainError(status, code, message);
}
function unavailable(code = "dependency_unavailable") {
  return fail(503, code, "Required integration is not configured.");
}
export {
  DomainError,
  fail,
  unavailable
};
