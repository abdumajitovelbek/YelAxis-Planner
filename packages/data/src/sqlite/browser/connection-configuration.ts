/** Only this exact connection setting is non-persistent; concatenated SQL must stay durable. */
export function isConnectionConfiguration(sql: string): boolean {
  return /^\s*PRAGMA\s+foreign_keys\s*=\s*ON\s*;\s*$/iu.test(sql);
}
