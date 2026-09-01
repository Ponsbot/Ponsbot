/** Never log raw errors, stacks, causes, or validation inputs from the signer. */
export function redactSignerDiagnostic(message: string, limit = 500): string {
  return message
    .replace(/https?:\/\/[^\s)]+/gi, "[url-redacted]")
    .replace(/\b0x[a-fA-F0-9]{128,}\b/g, "[signed-transaction-redacted]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|secret|password|authorization|access[_-]?token|private[_-]?key)\s*[=:]\s*["']?[^\s,;"']+/gi, "$1=[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[credential-redacted]")
    .slice(0, limit);
}
