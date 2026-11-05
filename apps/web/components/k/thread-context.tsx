"use client";
// Shared state of the open thread. Messages register here, and the reply (a
// single editor, anchored at the bottom of the pane) targets one of them.
import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { MessageEntity } from "@db";

export type ReplyMode = "reply" | "replyAll" | "forward";

type Ctx = {
	threadId: string;
	activeMailboxId: string;
	activeMailboxKind: string;
	markSmtp: boolean;
	register: (m: MessageEntity) => void;
	getMessage: (id: string) => MessageEntity | undefined;
	reply: { messageId: string; mode: ReplyMode } | null;
	openReply: (messageId: string, mode: ReplyMode) => void;
	closeReply: () => void;
};

const ThreadCtx = createContext<Ctx | null>(null);

export function useThread() {
	const ctx = useContext(ThreadCtx);
	if (!ctx) throw new Error("useThread outside <ThreadProvider>");
	return ctx;
}

export function useThreadOptional() {
	return useContext(ThreadCtx);
}

export function ThreadProvider({
	threadId,
	activeMailboxId,
	activeMailboxKind,
	markSmtp,
	children,
}: {
	threadId: string;
	activeMailboxId: string;
	activeMailboxKind: string;
	markSmtp: boolean;
	children: React.ReactNode;
}) {
	const messages = useRef(new Map<string, MessageEntity>());
	const [reply, setReply] = useState<Ctx["reply"]>(null);
	const register = useCallback((m: MessageEntity) => {
		messages.current.set(m.id, m);
	}, []);
	const getMessage = useCallback((id: string) => messages.current.get(id), []);
	const openReply = useCallback((messageId: string, mode: ReplyMode) => setReply({ messageId, mode }), []);
	const closeReply = useCallback(() => setReply(null), []);

	const value = useMemo(
		() => ({ threadId, activeMailboxId, activeMailboxKind, markSmtp, register, getMessage, reply, openReply, closeReply }),
		[threadId, activeMailboxId, activeMailboxKind, markSmtp, register, getMessage, reply, openReply, closeReply],
	);
	return <ThreadCtx.Provider value={value}>{children}</ThreadCtx.Provider>;
}
