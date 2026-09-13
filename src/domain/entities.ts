import { randomUUID } from 'node:crypto';

/**
 * Bloques de contenido tal como los devuelve (y los espera) la API de Anthropic.
 * Se guardan enteros, no solo el texto: reanudar una conversación exige devolver
 * los bloques `tool_use` y `tool_result` con sus identificadores intactos.
 */
export type ContentBlock = Record<string, unknown>;

export type MessageRole = 'user' | 'assistant';
export type ActionStatus = 'proposed' | 'executed' | 'rejected' | 'failed';

export interface ConversationProps {
  id: string;
  organizationId: string;
  userId: string;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export class Conversation {
  private constructor(private props: ConversationProps) {}

  static create(params: { organizationId: string; userId: string; title?: string | null }): Conversation {
    const now = new Date();
    return new Conversation({
      id: randomUUID(),
      organizationId: params.organizationId,
      userId: params.userId,
      title: params.title ?? null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
  }

  static fromPersistence(props: ConversationProps): Conversation {
    return new Conversation({ ...props });
  }

  get id(): string { return this.props.id; }
  get organizationId(): string { return this.props.organizationId; }
  get userId(): string { return this.props.userId; }
  get title(): string | null { return this.props.title; }
  get createdAt(): Date { return this.props.createdAt; }
  get updatedAt(): Date { return this.props.updatedAt; }
  get deletedAt(): Date | null { return this.props.deletedAt; }
  get isDeleted(): boolean { return this.props.deletedAt !== null; }

  /**
   * El título sale de la primera frase del usuario, recortada. Nada de pedirle
   * al modelo que titule: sería una llamada más y dinero por un adorno.
   */
  titleFrom(text: string): void {
    if (this.props.title) return;
    const clean = text.trim().replace(/\s+/g, ' ');
    this.props.title = clean.length > 80 ? `${clean.slice(0, 77)}…` : clean;
  }

  touch(): void {
    this.props.updatedAt = new Date();
  }

  /** Un hilo solo lo ve quien lo abrió, y solo dentro de su organización. */
  belongsTo(organizationId: string, userId: string): boolean {
    return this.props.organizationId === organizationId && this.props.userId === userId;
  }

  toJSON(): ConversationProps {
    return { ...this.props };
  }
}

export interface MessageProps {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: ContentBlock[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  createdAt: Date;
}

export class Message {
  private constructor(private props: MessageProps) {}

  static create(params: {
    conversationId: string;
    role: MessageRole;
    content: ContentBlock[];
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
  }): Message {
    return new Message({
      id: randomUUID(),
      conversationId: params.conversationId,
      role: params.role,
      content: params.content,
      inputTokens: params.inputTokens ?? 0,
      outputTokens: params.outputTokens ?? 0,
      cacheReadTokens: params.cacheReadTokens ?? 0,
      createdAt: new Date(),
    });
  }

  static fromPersistence(props: MessageProps): Message {
    return new Message({ ...props });
  }

  get id(): string { return this.props.id; }
  get conversationId(): string { return this.props.conversationId; }
  get role(): MessageRole { return this.props.role; }
  get content(): ContentBlock[] { return this.props.content; }
  get inputTokens(): number { return this.props.inputTokens; }
  get outputTokens(): number { return this.props.outputTokens; }
  get cacheReadTokens(): number { return this.props.cacheReadTokens; }
  get createdAt(): Date { return this.props.createdAt; }

  /** El texto plano, para enseñarlo en la interfaz sin exponer los bloques. */
  get text(): string {
    return this.props.content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n')
      .trim();
  }

  toJSON(): MessageProps {
    return { ...this.props };
  }
}

export interface PendingActionProps {
  id: string;
  conversationId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  summary: string;
  status: ActionStatus;
  result: unknown | null;
  decidedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Una escritura que el asistente quiere hacer y que espera a que una persona la
 * apruebe. Es la pieza que convierte al agente en algo que se puede soltar en
 * producción: sin ella, cualquier texto que entre en el contexto (el nombre de
 * un cliente, por ejemplo) podría acabar creando roles.
 */
export class PendingAction {
  private constructor(private props: PendingActionProps) {}

  static propose(params: {
    conversationId: string;
    toolUseId: string;
    toolName: string;
    input: Record<string, unknown>;
    summary: string;
  }): PendingAction {
    const now = new Date();
    return new PendingAction({
      id: randomUUID(),
      conversationId: params.conversationId,
      toolUseId: params.toolUseId,
      toolName: params.toolName,
      input: params.input,
      summary: params.summary,
      status: 'proposed',
      result: null,
      decidedByUserId: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  static fromPersistence(props: PendingActionProps): PendingAction {
    return new PendingAction({ ...props });
  }

  get id(): string { return this.props.id; }
  get conversationId(): string { return this.props.conversationId; }
  get toolUseId(): string { return this.props.toolUseId; }
  get toolName(): string { return this.props.toolName; }
  get input(): Record<string, unknown> { return this.props.input; }
  get summary(): string { return this.props.summary; }
  get status(): ActionStatus { return this.props.status; }
  get result(): unknown | null { return this.props.result; }

  get isPending(): boolean { return this.props.status === 'proposed'; }

  markExecuted(result: unknown, userId: string): void {
    this.props.status = 'executed';
    this.props.result = result;
    this.props.decidedByUserId = userId;
    this.props.updatedAt = new Date();
  }

  markFailed(result: unknown, userId: string): void {
    this.props.status = 'failed';
    this.props.result = result;
    this.props.decidedByUserId = userId;
    this.props.updatedAt = new Date();
  }

  markRejected(userId: string): void {
    this.props.status = 'rejected';
    this.props.decidedByUserId = userId;
    this.props.updatedAt = new Date();
  }

  toJSON(): PendingActionProps {
    return { ...this.props };
  }
}
