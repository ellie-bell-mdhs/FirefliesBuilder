/** Minimal timestamped logger with a scope prefix. */
export function makeLogger(scope: string) {
  const tag = `[${scope}]`;
  const stamp = () => new Date().toISOString().slice(11, 19);
  return {
    info: (...a: unknown[]) => console.log(stamp(), tag, ...a),
    warn: (...a: unknown[]) => console.warn(stamp(), tag, "WARN", ...a),
    error: (...a: unknown[]) => console.error(stamp(), tag, "ERROR", ...a),
  };
}

export type Logger = ReturnType<typeof makeLogger>;
