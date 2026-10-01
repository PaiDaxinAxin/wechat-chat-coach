export class BetaError extends Error {
  constructor(code, status = 400) { super(code); this.name = 'BetaError'; this.code = code; this.status = status; }
}

export function safeUser(row) { return row ? { id: row.id, username: row.username, plan: row.plan, role: row.role } : null; }
