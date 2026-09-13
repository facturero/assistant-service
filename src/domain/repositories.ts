import { Conversation, Message, PendingAction } from './entities';

export interface ConversationRepository {
  save(conversation: Conversation): Promise<void>;
  /** No devuelve las borradas: un hilo borrado se trata como inexistente. */
  findById(id: string): Promise<Conversation | null>;
  /** Hilos de un usuario dentro de su organización, del más reciente al más viejo. */
  listByUser(organizationId: string, userId: string, limit: number): Promise<Conversation[]>;
  /**
   * Borrado virtual: marca `deleted_at` y nada más. Mensajes y acciones se
   * quedan en la base como rastro de lo que el asistente hizo.
   */
  softDelete(id: string): Promise<void>;
}

export interface MessageRepository {
  save(message: Message): Promise<void>;
  listByConversation(conversationId: string): Promise<Message[]>;
}

export interface PendingActionRepository {
  save(action: PendingAction): Promise<void>;
  findById(id: string): Promise<PendingAction | null>;
  listByConversation(conversationId: string): Promise<PendingAction[]>;
}

export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

export interface UsageRepository {
  /** Consumo acumulado de la organización en la ventana actual (mes). */
  current(organizationId: string): Promise<UsageSnapshot>;
  add(organizationId: string, delta: UsageSnapshot): Promise<void>;
}

export interface Repositories {
  conversations: ConversationRepository;
  messages: MessageRepository;
  actions: PendingActionRepository;
  usage: UsageRepository;
}
