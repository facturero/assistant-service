export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ConversationNotFoundError extends DomainError {
  constructor() {
    super('La conversación no existe.', 'CONVERSATION_NOT_FOUND', 404);
  }
}

export class ActionNotFoundError extends DomainError {
  constructor() {
    super('La acción propuesta no existe.', 'ACTION_NOT_FOUND', 404);
  }
}

export class ActionAlreadyDecidedError extends DomainError {
  constructor() {
    super('Esa acción ya se decidió antes.', 'ACTION_ALREADY_DECIDED', 409);
  }
}

export class UnknownToolError extends DomainError {
  constructor(name: string) {
    super(`El asistente pidió una herramienta que no existe: ${name}.`, 'UNKNOWN_TOOL', 400);
  }
}

/**
 * El asistente va incluido en la plataforma, así que su coste lo paga la casa.
 * El límite existe para que una organización no se lleve por delante el margen
 * de todas las demás.
 */
export class UsageLimitReachedError extends DomainError {
  constructor() {
    super(
      'Tu organización llegó al límite de uso del asistente para este mes.',
      'ASSISTANT_LIMIT_REACHED',
      429,
    );
  }
}

export class AssistantUnavailableError extends DomainError {
  constructor(detail: string) {
    super(`El asistente no está disponible: ${detail}`, 'ASSISTANT_UNAVAILABLE', 503);
  }
}
