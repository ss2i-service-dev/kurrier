"use client";
// Slot for the signature preview in the editor. The editor footer
// (editor-footer) keeps the "Include" checkbox and the status, but in the
// modern interface the preview is shown where the signature will actually be
// placed on send (packages/common/src/compose.ts): below the text, above the
// quote (RFC-style forward: at the very bottom).
import { createContext, useContext } from "react";

export const KSignatureSlot = createContext<HTMLElement | null>(null);
export const useKSignatureSlot = () => useContext(KSignatureSlot);
