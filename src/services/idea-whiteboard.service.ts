/**
 * アイデアホワイトボードサービス (v1.5.0)
 *
 * 付箋の投稿・閲覧制御を担当する。
 *
 * 匿名化方針:
 *   - submittedBy は DB に保存するが、いかなる返り値にも含めない。
 *   - アクティブ中: 自分の付箋のみ返す (isOwnNote フラグ付き)。
 *   - クローズ後: 全付箋を返す (isOwnNote フラグで本人識別)。
 *
 * セッションライフサイクル:
 *   active → closed (endsAt 到達 or 作成者手動クローズ)
 */

import { prisma } from '@/lib/db';
import { generateEmbedding } from '@/services/embedding.service';
import type { CreateWhiteboardSessionInput, CreateWhiteboardNoteInput, UpdateWhiteboardNoteInput } from '@/lib/validators/idea-session';

// ============================================================
// DTO 型
// ============================================================

export type WhiteboardNoteDTO = {
  id: string;
  content: string;
  category: string | null;
  isOwnNote: boolean;
  createdAt: string;
  updatedAt: string;
};

export type WhiteboardSessionDTO = {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: string;
  endsAt: string;
  closedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  notes: WhiteboardNoteDTO[];
  totalNotes: number;
};

// ============================================================
// 内部: lazy auto-close
// ============================================================

async function maybeAutoClose(sessionId: string, endsAt: Date, tenantId: string): Promise<void> {
  if (endsAt > new Date()) return;
  await prisma.ideaWhiteboardSession.updateMany({
    where: { id: sessionId, tenantId, status: 'active' },
    data: { status: 'closed', closedAt: new Date() },
  });
}

// ============================================================
// 内部: session → DTO
// ============================================================

type RawSession = Awaited<ReturnType<typeof fetchSessionRaw>>;

async function fetchSessionRaw(sessionId: string, tenantId: string) {
  return prisma.ideaWhiteboardSession.findFirst({
    where: { id: sessionId, tenantId, deletedAt: null },
    include: {
      notes: {
        where: { deletedAt: null },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
}

function toDTO(raw: NonNullable<RawSession>, userId: string): WhiteboardSessionDTO {
  const isClosed = raw.status === 'closed';

  const notes: WhiteboardNoteDTO[] = isClosed
    ? raw.notes.map((n) => ({
        id: n.id,
        content: n.content,
        category: n.category,
        isOwnNote: n.submittedBy === userId,
        createdAt: n.createdAt.toISOString(),
        updatedAt: n.updatedAt.toISOString(),
      }))
    : raw.notes
        .filter((n) => n.submittedBy === userId)
        .map((n) => ({
          id: n.id,
          content: n.content,
          category: n.category,
          isOwnNote: true,
          createdAt: n.createdAt.toISOString(),
          updatedAt: n.updatedAt.toISOString(),
        }));

  return {
    id: raw.id,
    projectId: raw.projectId,
    title: raw.title,
    description: raw.description,
    status: raw.status,
    endsAt: raw.endsAt.toISOString(),
    closedAt: raw.closedAt?.toISOString() ?? null,
    createdBy: raw.createdBy,
    createdAt: raw.createdAt.toISOString(),
    updatedAt: raw.updatedAt.toISOString(),
    notes,
    totalNotes: raw.notes.length,
  };
}

// ============================================================
// Public API
// ============================================================

/**
 * ホワイトボードセッション一覧。
 */
export async function listWhiteboardSessions(
  projectId: string,
  userId: string,
  tenantId: string,
  status?: string,
  q?: string,
): Promise<WhiteboardSessionDTO[]> {
  const rows = await prisma.ideaWhiteboardSession.findMany({
    where: {
      projectId,
      tenantId,
      deletedAt: null,
      ...(status ? { status } : {}),
      ...(q ? { title: { contains: q, mode: 'insensitive' as const } } : {}),
    },
    include: {
      notes: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const needsClose = rows.filter((r) => r.status === 'active' && r.endsAt <= new Date());
  if (needsClose.length > 0) {
    await prisma.ideaWhiteboardSession.updateMany({
      where: { tenantId, id: { in: needsClose.map((r) => r.id) }, status: 'active' },
      data: { status: 'closed', closedAt: new Date() },
    });
    for (const r of needsClose) {
      r.status = 'closed';
    }
  }

  return rows.map((r) => toDTO(r, userId));
}

/**
 * ホワイトボードセッション単件取得。
 *
 * @throws {Error} 'NOT_FOUND'
 */
export async function getWhiteboardSession(
  sessionId: string,
  userId: string,
  tenantId: string,
): Promise<WhiteboardSessionDTO> {
  const raw = await fetchSessionRaw(sessionId, tenantId);
  if (!raw) throw new Error('NOT_FOUND');

  await maybeAutoClose(raw.id, raw.endsAt, tenantId);
  if (raw.status === 'active' && raw.endsAt <= new Date()) {
    raw.status = 'closed';
  }

  return toDTO(raw, userId);
}

/**
 * ホワイトボードセッション作成。
 *
 * @throws {Error} 'INVALID_ENDS_AT'
 */
export async function createWhiteboardSession(
  projectId: string,
  data: CreateWhiteboardSessionInput,
  userId: string,
  tenantId: string,
): Promise<WhiteboardSessionDTO> {
  const endsAt = new Date(data.endsAt);
  if (endsAt <= new Date()) throw new Error('INVALID_ENDS_AT');

  const session = await prisma.ideaWhiteboardSession.create({
    data: {
      tenantId,
      projectId,
      title: data.title,
      description: data.description ?? null,
      endsAt,
      createdBy: userId,
      updatedBy: userId,
    },
    include: {
      notes: { where: { deletedAt: null } },
    },
  });

  return toDTO(session, userId);
}

/**
 * セッションを手動クローズ。作成者のみ。
 *
 * @throws {Error} 'NOT_FOUND' | 'FORBIDDEN' | 'ALREADY_CLOSED'
 */
export async function closeWhiteboardSession(
  sessionId: string,
  userId: string,
  tenantId: string,
): Promise<WhiteboardSessionDTO> {
  const raw = await fetchSessionRaw(sessionId, tenantId);
  if (!raw) throw new Error('NOT_FOUND');
  if (raw.createdBy !== userId) throw new Error('FORBIDDEN');
  if (raw.status === 'closed') throw new Error('ALREADY_CLOSED');

  await prisma.ideaWhiteboardSession.update({
    where: { id: sessionId },
    data: { status: 'closed', closedBy: userId, closedAt: new Date(), updatedBy: userId },
  });
  raw.status = 'closed';

  // fire-and-forget: クローズ後に embedding 生成 (失敗してもクローズ自体は完了扱い)
  void (async () => {
    const parts = [
      raw.title,
      raw.description ?? '',
      ...raw.notes.map((n) => n.content),
    ];
    const text = parts.filter(Boolean).join('\n');
    const result = await generateEmbedding({
      text,
      featureUnit: 'idea-whiteboard-embedding',
      tenantId,
      userId,
      inputType: 'document',
    });
    if (result.ok) {
      const vectorLiteral = `[${result.embedding.join(',')}]`;
      await prisma.$executeRaw`
        UPDATE "idea_whiteboard_sessions"
           SET "content_embedding" = ${vectorLiteral}::vector
         WHERE id = ${sessionId}::uuid AND tenant_id = ${tenantId}::uuid
      `;
    }
  })();

  return toDTO(raw, userId);
}

/**
 * 付箋投稿。アクティブ中のみ受け付ける。
 *
 * @throws {Error} 'NOT_FOUND' | 'SESSION_CLOSED'
 */
export async function createNote(
  sessionId: string,
  data: CreateWhiteboardNoteInput,
  userId: string,
  tenantId: string,
): Promise<WhiteboardNoteDTO> {
  const session = await prisma.ideaWhiteboardSession.findFirst({
    where: { id: sessionId, tenantId, deletedAt: null },
    select: { status: true, endsAt: true },
  });
  if (!session) throw new Error('NOT_FOUND');

  if (session.status === 'active' && session.endsAt <= new Date()) {
    await maybeAutoClose(sessionId, session.endsAt, tenantId);
    throw new Error('SESSION_CLOSED');
  }
  if (session.status === 'closed') throw new Error('SESSION_CLOSED');

  const note = await prisma.ideaWhiteboardNote.create({
    data: {
      sessionId,
      tenantId,
      submittedBy: userId,
      content: data.content,
      category: data.category ?? null,
    },
  });

  return {
    id: note.id,
    content: note.content,
    category: note.category,
    isOwnNote: true,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
  };
}

/**
 * 付箋更新。投稿者本人のみ。アクティブ中のみ。
 *
 * @throws {Error} 'NOT_FOUND' | 'FORBIDDEN' | 'SESSION_CLOSED'
 */
export async function updateNote(
  noteId: string,
  data: UpdateWhiteboardNoteInput,
  userId: string,
  tenantId: string,
): Promise<WhiteboardNoteDTO> {
  const note = await prisma.ideaWhiteboardNote.findFirst({
    where: { id: noteId, tenantId, deletedAt: null },
    include: { session: { select: { status: true, endsAt: true } } },
  });
  if (!note) throw new Error('NOT_FOUND');
  if (note.submittedBy !== userId) throw new Error('FORBIDDEN');

  const session = note.session;
  if (session.status === 'active' && session.endsAt <= new Date()) {
    await maybeAutoClose(note.sessionId, session.endsAt, tenantId);
    throw new Error('SESSION_CLOSED');
  }
  if (session.status === 'closed') throw new Error('SESSION_CLOSED');

  const updated = await prisma.ideaWhiteboardNote.update({
    where: { id: noteId },
    data: {
      ...(data.content !== undefined ? { content: data.content } : {}),
      ...(data.category !== undefined ? { category: data.category ?? null } : {}),
    },
  });

  return {
    id: updated.id,
    content: updated.content,
    category: updated.category,
    isOwnNote: true,
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
  };
}

/**
 * 付箋論理削除。投稿者本人のみ。
 *
 * @throws {Error} 'NOT_FOUND' | 'FORBIDDEN'
 */
export async function deleteNote(
  noteId: string,
  userId: string,
  tenantId: string,
): Promise<void> {
  const note = await prisma.ideaWhiteboardNote.findFirst({
    where: { id: noteId, tenantId, deletedAt: null },
    select: { submittedBy: true },
  });
  if (!note) throw new Error('NOT_FOUND');
  if (note.submittedBy !== userId) throw new Error('FORBIDDEN');

  await prisma.ideaWhiteboardNote.update({
    where: { id: noteId },
    data: { deletedAt: new Date() },
  });
}

/**
 * ホワイトボードセッション論理削除。作成者のみ。
 *
 * @throws {Error} 'NOT_FOUND' | 'FORBIDDEN'
 */
export async function deleteWhiteboardSession(
  sessionId: string,
  userId: string,
  tenantId: string,
): Promise<void> {
  const row = await prisma.ideaWhiteboardSession.findFirst({
    where: { id: sessionId, tenantId, deletedAt: null },
    select: { createdBy: true },
  });
  if (!row) throw new Error('NOT_FOUND');
  if (row.createdBy !== userId) throw new Error('FORBIDDEN');

  await prisma.ideaWhiteboardSession.update({
    where: { id: sessionId },
    data: { deletedAt: new Date(), updatedBy: userId },
  });
}
