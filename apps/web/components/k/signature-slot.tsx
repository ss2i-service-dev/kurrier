"use client";
// SS2i (Outlook) : emplacement de l'apercu de signature dans l'editeur. Le pied
// de l'editeur (editor-footer) garde la case « Inclure » et l'etat, mais en
// Outlook l'apercu s'affiche la ou la signature sera reellement placee a
// l'envoi (packages/common/src/compose.ts) : sous le texte, au-dessus de la
// citation (en style RFC d'un transfert : tout en bas).
import { createContext, useContext } from "react";

export const KSignatureSlot = createContext<HTMLElement | null>(null);
export const useKSignatureSlot = () => useContext(KSignatureSlot);
